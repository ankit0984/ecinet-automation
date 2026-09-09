import sys
from pathlib import Path
from PIL import Image
import torch
from transformers import TrOCRProcessor, ViTImageProcessor, RobertaTokenizer, VisionEncoderDecoderModel

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FINETUNED_MODEL_DIR = PROJECT_ROOT / "model_training" / "checkpoints" / "best_hf_captcha_model"
LOCAL_BASE_MODEL = PROJECT_ROOT / "model_training" / "checkpoints" / "base_hf_captcha_model"
FALLBACK_MODEL = "anuashok/ocr-captcha-v3"

DEVICE = torch.device("cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu"))


def load_model_and_processor():
    if FINETUNED_MODEL_DIR.exists() and (FINETUNED_MODEL_DIR / "model.safetensors").exists():
        model_path = str(FINETUNED_MODEL_DIR)
        print(f"Loading fine-tuned model from local path: {model_path}")
        is_local = True
    elif LOCAL_BASE_MODEL.exists() and (LOCAL_BASE_MODEL / "model.safetensors").exists():
        model_path = str(LOCAL_BASE_MODEL)
        print(f"Loading base model from local path: {model_path}")
        is_local = True
    else:
        model_path = FALLBACK_MODEL
        print(f"Local models not found. Loading from Hugging Face: {model_path}")
        is_local = False

    try:
        processor = TrOCRProcessor.from_pretrained(model_path, local_files_only=is_local)
    except Exception:
        img_proc = ViTImageProcessor.from_pretrained(model_path, local_files_only=is_local)
        tok = RobertaTokenizer.from_pretrained(model_path, local_files_only=is_local)
        processor = TrOCRProcessor(image_processor=img_proc, tokenizer=tok)

    model = VisionEncoderDecoderModel.from_pretrained(
        model_path,
        local_files_only=is_local,
        attn_implementation="eager",
    ).to(DEVICE)
    if hasattr(model, "generation_config") and model.generation_config is not None:
        model.generation_config.max_length = None
        model.generation_config.max_new_tokens = 10
        model.generation_config.num_beams = 1
        model.generation_config.early_stopping = False
        model.generation_config.length_penalty = 1.0
    model.eval()
    return model, processor


def predict(image_path: str, model=None, processor=None) -> str:
    if model is None or processor is None:
        model, processor = load_model_and_processor()

    image = Image.open(image_path).convert("RGB")
    pixel_values = processor(image, return_tensors="pt").pixel_values.to(DEVICE)

    with torch.no_grad():
        generated_ids = model.generate(pixel_values, max_new_tokens=10)
        prediction = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]

    return prediction.strip().lower()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        img_path = sys.argv[1]
    else:
        img_path = str(PROJECT_ROOT / "dataset" / "images" / "captcha_003.jpg")

    model, processor = load_model_and_processor()
    result = predict(img_path, model, processor)
    print(f"\n[Result] Image: {img_path}")
    print(f"[Result] Predicted text: {result}")
