import os
import csv
from pathlib import Path
from PIL import Image
import torch
from torch.utils.data import Dataset, DataLoader
from transformers import (
    TrOCRProcessor,
    ViTImageProcessor,
    RobertaTokenizer,
    VisionEncoderDecoderModel,
    get_linear_schedule_with_warmup,
)
from tqdm import tqdm

from neural_inspector import training_state, compute_layer_gradients, inspect_image_neural_state
from web_dashboard import start_dashboard_server_in_thread, set_active_model_and_processor


# ============================================================
# Paths & Settings
# ============================================================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
IMAGE_DIR = PROJECT_ROOT / "dataset" / "images"
TRAIN_CSV = PROJECT_ROOT / "dataset" / "train.csv"
VAL_CSV = PROJECT_ROOT / "dataset" / "validation.csv"
LOCAL_BASE_MODEL = PROJECT_ROOT / "model_training" / "checkpoints" / "base_hf_captcha_model"
OUTPUT_DIR = PROJECT_ROOT / "model_training" / "checkpoints" / "best_hf_captcha_model"

HF_MODEL_NAME = "anuashok/ocr-captcha-v3"

BATCH_SIZE = 8
EPOCHS = 15
LEARNING_RATE = 5e-5
WEIGHT_DECAY = 0.01
MAX_TARGET_LENGTH = 16

DEVICE = torch.device("cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu"))


# ============================================================
# Dataset Definition
# ============================================================
class CaptchaHFDataset(Dataset):
    def __init__(self, csv_file, image_dir, processor, max_target_length=16):
        self.image_dir = Path(image_dir)
        self.processor = processor
        self.max_target_length = max_target_length
        self.samples = []

        with open(csv_file, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                cleaned = {k.strip(): v.strip() for k, v in row.items() if k and v}
                if "image" in cleaned and "label" in cleaned:
                    self.samples.append((cleaned["image"], cleaned["label"].lower()))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        img_name, label = self.samples[idx]
        img_path = self.image_dir / img_name

        image = Image.open(img_path).convert("RGB")
        pixel_values = self.processor(image, return_tensors="pt").pixel_values.squeeze(0)

        labels = self.processor.tokenizer(
            label,
            padding="max_length",
            max_length=self.max_target_length,
            return_tensors="pt",
        ).input_ids.squeeze(0)

        # Replace padding token id's of the label by -100 so they are ignored by CrossEntropyLoss
        labels = [label_id if label_id != self.processor.tokenizer.pad_token_id else -100 for label_id in labels]
        labels = torch.tensor(labels, dtype=torch.long)

        return {
            "pixel_values": pixel_values,
            "labels": labels,
            "image_name": img_name,
            "text": label,
        }


# ============================================================
# Evaluation Metric
# ============================================================
@torch.no_grad()
def evaluate(model, val_loader, processor):
    model.eval()
    total_samples = 0
    exact_match = 0
    char_correct = 0
    char_total = 0
    val_loss = 0.0

    predictions_list = []

    for batch in val_loader:
        pixel_values = batch["pixel_values"].to(DEVICE)
        labels = batch["labels"].to(DEVICE)

        outputs = model(pixel_values=pixel_values, labels=labels)
        val_loss += outputs.loss.item()

        # Generate predictions
        generated_ids = model.generate(pixel_values, max_new_tokens=10)
        preds = processor.batch_decode(generated_ids, skip_special_tokens=True)

        for pred, actual in zip(preds, batch["text"]):
            pred_clean = pred.strip().lower()
            actual_clean = actual.strip().lower()

            if pred_clean == actual_clean:
                exact_match += 1

            max_len = max(len(pred_clean), len(actual_clean))
            for i in range(max_len):
                if i < len(pred_clean) and i < len(actual_clean):
                    if pred_clean[i] == actual_clean[i]:
                        char_correct += 1
                char_total += 1

            total_samples += 1
            if len(predictions_list) < 5:
                predictions_list.append((actual_clean, pred_clean))

    exact_acc = exact_match / total_samples if total_samples > 0 else 0.0
    char_acc = char_correct / char_total if char_total > 0 else 0.0
    avg_loss = val_loss / len(val_loader) if len(val_loader) > 0 else 0.0

    return avg_loss, exact_acc, char_acc, predictions_list


# ============================================================
# Main Training Loop
# ============================================================
def main():
    print(f"Using device: {DEVICE}")

    # Determine whether to load from local disk or Hugging Face
    if LOCAL_BASE_MODEL.exists() and (LOCAL_BASE_MODEL / "model.safetensors").exists():
        model_source = str(LOCAL_BASE_MODEL)
        is_local = True
        print(f"Loading base model locally from disk: {LOCAL_BASE_MODEL}")
    else:
        model_source = HF_MODEL_NAME
        is_local = False
        print(f"Local model not found. Downloading from Hugging Face: {HF_MODEL_NAME}")

    # Load processor and model
    try:
        processor = TrOCRProcessor.from_pretrained(model_source, local_files_only=is_local)
    except Exception:
        img_proc = ViTImageProcessor.from_pretrained(model_source, local_files_only=is_local)
        tok = RobertaTokenizer.from_pretrained(model_source, local_files_only=is_local)
        processor = TrOCRProcessor(image_processor=img_proc, tokenizer=tok)

    model = VisionEncoderDecoderModel.from_pretrained(
        model_source,
        local_files_only=is_local,
        attn_implementation="eager",
    )

    # Set model config tokens
    model.config.decoder_start_token_id = processor.tokenizer.cls_token_id
    model.config.pad_token_id = processor.tokenizer.pad_token_id
    model.config.vocab_size = model.config.decoder.vocab_size
    model.config.eos_token_id = processor.tokenizer.sep_token_id

    # Generation parameters must be set on model.generation_config in transformers 5+
    if hasattr(model, "generation_config") and model.generation_config is not None:
        model.generation_config.decoder_start_token_id = processor.tokenizer.cls_token_id
        model.generation_config.pad_token_id = processor.tokenizer.pad_token_id
        model.generation_config.eos_token_id = processor.tokenizer.sep_token_id
        model.generation_config.max_length = None
        model.generation_config.max_new_tokens = 10
        model.generation_config.num_beams = 1
        model.generation_config.early_stopping = False
        model.generation_config.length_penalty = 1.0

    # Cache base model locally if it was downloaded from HF
    if not is_local:
        print(f"Caching base model locally to {LOCAL_BASE_MODEL}...")
        LOCAL_BASE_MODEL.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(LOCAL_BASE_MODEL)
        processor.save_pretrained(LOCAL_BASE_MODEL)

    model.to(DEVICE)

    # Datasets & Dataloaders
    train_dataset = CaptchaHFDataset(TRAIN_CSV, IMAGE_DIR, processor, MAX_TARGET_LENGTH)
    val_dataset = CaptchaHFDataset(VAL_CSV, IMAGE_DIR, processor, MAX_TARGET_LENGTH)

    train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=BATCH_SIZE, shuffle=False)

    print(f"Train samples: {len(train_dataset)} | Val samples: {len(val_dataset)}")

    # Total Steps
    total_steps = len(train_loader) * EPOCHS

    # Start Web GUI Dashboard server in background thread
    server, dashboard_port = start_dashboard_server_in_thread(8000)
    set_active_model_and_processor(model, processor)
    training_state.start_training(total_epochs=EPOCHS, total_steps=total_steps, device_name=str(DEVICE))
    if dashboard_port:
        print(f"📊 Live Neural Training Visualizer open at: http://localhost:{dashboard_port}\n")
    else:
        print("📊 Training starting (Web visualizer offline)\n")

    val_samples_to_inspect = [s[0] for s in val_dataset.samples[:6]]

    # Baseline Zero-Shot Evaluation
    print("--- Running Initial Zero-Shot Baseline ---")
    val_loss, exact_acc, char_acc, examples = evaluate(model, val_loader, processor)
    print(f"Zero-shot Val Exact Accuracy: {exact_acc * 100:.2f}% | Character Accuracy: {char_acc * 100:.2f}%")
    for actual, pred in examples:
        print(f"  expected={actual:<8} predicted={pred}")

    # Record initial baseline in visualizer
    initial_neural_samples = []
    for s_name in val_samples_to_inspect:
        exp_txt = next((s[1] for s in val_dataset.samples if s[0] == s_name), "")
        sample_data = inspect_image_neural_state(model, processor, IMAGE_DIR / s_name, exp_txt)
        initial_neural_samples.append(sample_data)
    training_state.set_samples(initial_neural_samples)
    training_state.record_epoch(0, val_loss, val_loss, exact_acc, char_acc)

    # Optimizer & Scheduler
    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    scheduler = get_linear_schedule_with_warmup(
        optimizer,
        num_warmup_steps=int(total_steps * 0.1),
        num_training_steps=total_steps,
    )

    best_exact_acc = exact_acc
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("\n--- Starting Fine-tuning ---")
    global_step = 0
    for epoch in range(1, EPOCHS + 1):
        model.train()
        train_loss = 0.0

        pbar = tqdm(train_loader, desc=f"Epoch {epoch:02d}/{EPOCHS}")
        for batch in pbar:
            global_step += 1
            pixel_values = batch["pixel_values"].to(DEVICE)
            labels = batch["labels"].to(DEVICE)

            optimizer.zero_grad()
            outputs = model(pixel_values=pixel_values, labels=labels)
            loss = outputs.loss

            loss.backward()
            grad_norms = compute_layer_gradients(model)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)

            optimizer.step()
            scheduler.step()

            train_loss += loss.item()
            current_lr = optimizer.param_groups[0]["lr"]
            training_state.update_step(epoch, global_step, loss.item(), current_lr, grad_norms)
            pbar.set_postfix({"loss": f"{loss.item():.4f}"})

        avg_train_loss = train_loss / len(train_loader)

        # Validation
        val_loss, exact_acc, char_acc, examples = evaluate(model, val_loader, processor)

        print(f"\n[Epoch {epoch:02d}/{EPOCHS}] Train Loss: {avg_train_loss:.4f} | Val Loss: {val_loss:.4f}")
        print(f"Validation Exact Accuracy: {exact_acc * 100:.2f}% | Char Accuracy: {char_acc * 100:.2f}%")
        print("Validation examples:")
        for actual, pred in examples[:3]:
            print(f"  expected={actual:<8} predicted={pred}")

        # Extract neural attention maps on validation samples
        epoch_neural_samples = []
        for s_name in val_samples_to_inspect:
            exp_txt = next((s[1] for s in val_dataset.samples if s[0] == s_name), "")
            sample_data = inspect_image_neural_state(model, processor, IMAGE_DIR / s_name, exp_txt)
            epoch_neural_samples.append(sample_data)
        training_state.set_samples(epoch_neural_samples)
        training_state.record_epoch(epoch, avg_train_loss, val_loss, exact_acc, char_acc)

        # Save Best Model
        if exact_acc >= best_exact_acc:
            best_exact_acc = exact_acc
            model.save_pretrained(OUTPUT_DIR)
            processor.save_pretrained(OUTPUT_DIR)
            print(f"✓ Saved new best model to {OUTPUT_DIR} (Exact Accuracy: {exact_acc * 100:.2f}%)")

    training_state.finish_training()
    print("\n==============================")
    print("Fine-tuning Complete!")
    print(f"Best Validation Exact Accuracy: {best_exact_acc * 100:.2f}%")
    print(f"Model saved at: {OUTPUT_DIR}")
    print(f"Web GUI Dashboard available at: http://localhost:{dashboard_port}")
    print("==============================")


if __name__ == "__main__":
    main()
