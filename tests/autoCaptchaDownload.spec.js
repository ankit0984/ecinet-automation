import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ======================== CONFIGURATION ========================
// Target districts: null for all districts, or specific array of codes/names
// const TARGET_DISTRICT = ["S1902", "S1919", "S1916", "S1915", "S1910", "S1923"];

const TARGET_DISTRICT = [
  "S1902",
  "S1919",
  "S1916",
  "S1915",
  "S1910",
  "S1923",
  "S1913",
  "S1901",
  "S1906",
  "S1905",
  "S1904",
  "S1911",
  "S1921",
  "S1917",
  "S1912",
  "S1922",
  "S1920",
  "S1908",
  "S1909",
  "S1918",
  "S1907",
  "S1914",
  "S1903"
];
// Districts to skip for specific dates
const SKIP_DISTRICTS_BY_DATE = {
  // '2026-08-27': ['S1902'],
};

// Form type to download (e.g. form9, form10)
const FORM_TYPE = 'form10';

// Dates configuration
const START_DATE = '2026-09-07';
const END_DATE = null; // null uses maximum allowed date from calendar

// Destination directories
const BASE_DOWNLOAD_DIR = 'data';
const IMAGES_DIR = path.join('data', 'captcha_images');
const CAPTCHA_DATA_JSON = path.join('data', 'captcha_data.json');
const CAPTCHA_LABELS_JSON = path.join('data', 'captcha_labels.json');
const TEMP_CAPTCHA_DIR = path.join('data', 'temp_captcha');

// Skip if PDF already exists in destination folder
const SKIP_EXISTING = true;

// Portal page URL
const TARGET_PAGE_URL = 'https://voters.eci.gov.in/download-statutory-report?stateCode=S19';

// Retry attempts if captcha is rejected or download times out
const MAX_CAPTCHA_RETRIES = 5;

// Keystroke delay when typing captcha one-by-one (in milliseconds)
const TYPING_DELAY_MS = 80;
// ===============================================================

// Helper: Sanitize directory and filenames
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// Helper: Generate array of dates between start and end (inclusive)
function generateDateRange(startStr, endStr) {
  const dates = [];
  const [sY, sM, sD] = startStr.split('-').map(Number);
  const [eY, eM, eD] = endStr.split('-').map(Number);
  let current = new Date(sY, sM - 1, sD);
  const end = new Date(eY, eM - 1, eD);

  while (current <= end) {
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Helper: Get next sequential captcha index
function getNextCaptchaIndex(existingRecords) {
  let maxIndex = existingRecords.length;
  if (fs.existsSync(IMAGES_DIR)) {
    const files = fs.readdirSync(IMAGES_DIR);
    for (const f of files) {
      const match = f.match(/^captcha_(\d+)\.jpg$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxIndex) maxIndex = num;
      }
    }
  }
  return maxIndex + 1;
}

// Helper: Keep kpi/index.html in sync with data/captcha_data.json
function syncKpiHtml(records) {
  const kpiFile = path.join('kpi', 'index.html');
  if (!fs.existsSync(kpiFile)) return;
  try {
    let html = fs.readFileSync(kpiFile, 'utf-8');
    const regex = /(<script id="embedded-data" type="application\/json">)[\s\S]*?(<\/script>)/;
    if (regex.test(html)) {
      html = html.replace(regex, `$1\n${JSON.stringify(records)}\n  $2`);
      fs.writeFileSync(kpiFile, html, 'utf-8');
    }
  } catch {}
}

// Helper: Resolve python virtual environment executable
function getPythonExecutable() {
  const projectRoot = process.cwd();
  const venvPythonUnix = path.join(projectRoot, 'captcha_reader_model', '.venv', 'bin', 'python');
  if (fs.existsSync(venvPythonUnix)) {
    return venvPythonUnix;
  }
  const venvPythonWin = path.join(projectRoot, 'captcha_reader_model', '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPythonWin)) {
    return venvPythonWin;
  }
  return 'python3';
}

// =========================================================================
// ⚡ Fast In-Memory Captcha Model Worker
// Keeps predict_hf loaded in memory so predictions take ~0.15s instead of 8s
// =========================================================================
class CaptchaModelWorker {
  constructor() {
    this.process = null;
    this.isReady = false;
    this.currentResolve = null;
    this.currentReject = null;
    this.buffer = '';
  }

  async start() {
    const pythonBin = getPythonExecutable();
    const scriptPath = path.resolve(process.cwd(), 'captcha_reader_model', 'model_training', 'predict_hf.py');

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`predict_hf.py not found at: ${scriptPath}`);
    }

    const runnerCode = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(r'''${scriptPath}''').parent))
from predict_hf import load_model_and_processor, predict

model, processor = load_model_and_processor()
print("WORKER_READY", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        text = predict(line, model, processor)
        print(f"PRED:{text}", flush=True)
    except Exception as e:
        print(f"ERR:{e}", flush=True)
`;

    console.log(`🤖 Starting in-memory Captcha Model Worker...`);
    this.process = spawn(pythonBin, ['-u', '-c', runnerCode], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    return new Promise((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        reject(new Error('Captcha model worker startup timed out after 60s'));
      }, 60000);

      const onData = (data) => {
        this.buffer += data.toString();
        if (this.buffer.includes('WORKER_READY')) {
          clearTimeout(startupTimeout);
          this.isReady = true;
          this.buffer = '';
          this.process.stdout.removeListener('data', onData);
          this.process.stdout.on('data', (d) => this._onData(d));
          console.log(`✨ Captcha Model Worker loaded and ready!`);
          resolve();
        }
      };

      this.process.stdout.on('data', onData);
      this.process.on('error', (err) => {
        clearTimeout(startupTimeout);
        reject(err);
      });
    });
  }

  _onData(data) {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('PRED:')) {
        const text = trimmed.slice(5).trim();
        if (this.currentResolve) {
          const res = this.currentResolve;
          this.currentResolve = null;
          this.currentReject = null;
          res(text);
        }
      } else if (trimmed.startsWith('ERR:')) {
        const err = trimmed.slice(4).trim();
        if (this.currentReject) {
          const rej = this.currentReject;
          this.currentResolve = null;
          this.currentReject = null;
          rej(new Error(err));
        }
      }
    }
  }

  async predict(imagePath) {
    if (!this.isReady) {
      await this.start();
    }
    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;
      this.process.stdin.write(path.resolve(imagePath) + '\n');
    });
  }

  stop() {
    if (this.process) {
      try {
        this.process.stdin.end();
        this.process.kill();
      } catch {}
      this.process = null;
      this.isReady = false;
    }
  }
}

// Global fallback CLI prediction if worker fails
async function predictFallbackCLI(imagePath) {
  const pythonBin = getPythonExecutable();
  const scriptPath = path.resolve(process.cwd(), 'captcha_reader_model', 'model_training', 'predict_hf.py');
  const { stdout } = await execFileAsync(pythonBin, [scriptPath, imagePath], { timeout: 60000 });
  const match = stdout.match(/\[Result\]\s*Predicted\s*text:\s*([^\r\n]+)/i);
  return match ? match[1].trim() : '';
}

// Helper: Locator for CAPTCHA image
function getCaptchaImgLocator(page) {
  return page.locator([
    'img[alt="Captcha"]',
    'img[alt*="captcha" i]:not([alt*="refrsh"]):not([alt*="refresh"]):not([alt*="QR"])'
  ].join(', ')).first();
}

// Helper: Locator for Refresh button
function getRefreshBtnLocator(page) {
  return page.locator([
    'img[alt*="refresh" i]',
    'img[alt*="refrsh" i]',
    'button:has(img[alt*="refresh" i])',
    'button:has(img[alt*="refrsh" i])',
    'button[aria-label*="refresh" i]',
    'i[class*="refresh" i]',
    'svg[data-icon="arrows-rotate"]'
  ].join(', ')).first();
}

// Helper: Save captcha image to disk (from Base64 or element screenshot)
async function saveCaptchaImage(page, destinationPath) {
  const captchaImgLocator = getCaptchaImgLocator(page);
  await captchaImgLocator.waitFor({ state: 'visible', timeout: 15000 });
  const src = await captchaImgLocator.getAttribute('src');

  if (src && src.startsWith('data:image')) {
    const base64Data = src.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(destinationPath, Buffer.from(base64Data, 'base64'));
  } else {
    await captchaImgLocator.screenshot({ path: destinationPath });
  }

  return src;
}

// Helper: Wait until the captcha image src changes to a new value
async function waitForCaptchaSrcToChange(page, oldSrc, timeoutMs = 8000) {
  await page.waitForFunction(
    (prev) => {
      const img = document.querySelector('img[alt="Captcha"], img[alt*="captcha" i]:not([alt*="refrsh"]):not([alt*="refresh"]):not([alt*="QR"])');
      const current = img ? img.getAttribute('src') : null;
      return current && current !== prev && current.length > 50;
    },
    oldSrc,
    { timeout: timeoutMs }
  ).catch(() => {});
}

// Helper: Type characters one by one into input field
async function fillCaptchaOneByOne(page, captchaInput, text, delayMs = TYPING_DELAY_MS) {
  await captchaInput.focus();
  await captchaInput.fill('');
  await page.waitForTimeout(100);

  console.log(`  ⌨️ Typing CAPTCHA "${text}" character by character...`);
  for (const char of text) {
    await captchaInput.pressSequentially(char, { delay: delayMs });
    await page.waitForTimeout(30);
  }

  await captchaInput.dispatchEvent('input').catch(() => {});
  await captchaInput.dispatchEvent('change').catch(() => {});
}

// =========================================================================
// 🚀 Automated Statutory Report Downloader with Verified CAPTCHA Storage
// =========================================================================
test('Form Automation & Statutory Report Downloader with AI Captcha Solver', async ({ page }) => {
  test.setTimeout(0); // Disable overall timeout for full batch run

  // Handle any unexpected alert dialogs automatically
  page.on('dialog', async (dialog) => {
    console.log(`  💬 Portal dialog popped up: "${dialog.message()}"`);
    await dialog.accept().catch(() => {});
  });

  // Ensure directories exist
  if (!fs.existsSync(BASE_DOWNLOAD_DIR)) fs.mkdirSync(BASE_DOWNLOAD_DIR, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
  if (!fs.existsSync(TEMP_CAPTCHA_DIR)) fs.mkdirSync(TEMP_CAPTCHA_DIR, { recursive: true });

  // Load existing datasets
  let allRecords = [];
  let labelMap = {};

  if (fs.existsSync(CAPTCHA_DATA_JSON)) {
    try {
      const data = JSON.parse(fs.readFileSync(CAPTCHA_DATA_JSON, 'utf-8'));
      if (Array.isArray(data)) allRecords = data;
    } catch {}
  }

  if (fs.existsSync(CAPTCHA_LABELS_JSON)) {
    try {
      labelMap = JSON.parse(fs.readFileSync(CAPTCHA_LABELS_JSON, 'utf-8'));
    } catch {}
  }

  console.log(`\n======================================================`);
  console.log(`🚀 Started Automated Statutory Report Downloader`);
  console.log(`🤖 AI CAPTCHA Model: predict_hf.py`);
  console.log(`📋 Target Districts: ${JSON.stringify(TARGET_DISTRICT)}`);
  console.log(`📄 Form Type: ${FORM_TYPE}`);
  console.log(`📊 Existing labeled CAPTCHAs: ${allRecords.length}`);
  console.log(`🌐 Target Portal: ${TARGET_PAGE_URL}`);
  console.log(`======================================================\n`);

  // Start fast in-memory worker
  const worker = new CaptchaModelWorker();
  try {
    await worker.start();
  } catch (err) {
    console.warn(`⚠️ Could not start in-memory worker (${err.message}). Will fallback to CLI.`);
  }

  try {
    await page.goto(TARGET_PAGE_URL, { waitUntil: 'commit', timeout: 60000 }).catch(err => {
      console.log(`⚠️ Navigation notice: ${err.message}`);
    });

    // 1. Wait for District dropdown to populate
    const districtSelect = page.getByLabel('District');
    await page.waitForFunction(
      () => {
        const labels = Array.from(document.querySelectorAll('label'));
        const dLabel = labels.find(l => l.innerText?.includes('District'));
        const select = dLabel ? document.getElementById(dLabel.htmlFor) || dLabel.querySelector('select') : null;
        return select && select.options.length > 1;
      },
      null,
      { timeout: 30000 }
    ).catch(() => {});

    // Extract all District options
    const districtElements = await districtSelect.locator('option').all();
    let districtList = [];
    for (const opt of districtElements) {
      const value = await opt.getAttribute('value');
      const text = (await opt.textContent())?.trim();
      if (value && value !== '' && value !== '0' && !text?.toLowerCase().includes('select')) {
        districtList.push({ value, label: text });
      }
    }

    // Filter if target district is set
    if (TARGET_DISTRICT) {
      if (Array.isArray(TARGET_DISTRICT)) {
        if (TARGET_DISTRICT.length > 0) {
          districtList = districtList.filter(d => TARGET_DISTRICT.includes(d.value) || TARGET_DISTRICT.includes(d.label));
        }
      } else {
        districtList = districtList.filter(d => d.value === TARGET_DISTRICT || d.label === TARGET_DISTRICT);
      }
    }

    console.log(`🏛️ Found ${districtList.length} District(s) to process.`);

    // 2. Loop through each District
    for (let dIdx = 0; dIdx < districtList.length; dIdx++) {
      const district = districtList[dIdx];
      const cleanDistrictName = sanitizeName(district.label);
      const targetDir = path.join(BASE_DOWNLOAD_DIR, cleanDistrictName);
      fs.mkdirSync(targetDir, { recursive: true });

      console.log(`\n======================================================`);
      console.log(`🏛️ [District ${dIdx + 1}/${districtList.length}] ${district.label} (${district.value})`);
      console.log(`📁 Target folder: ${targetDir}`);
      console.log(`======================================================`);

      // Select District
      await page.getByLabel('District').selectOption(district.value);

      // Wait for Assembly Constituency dropdown to update
      const acSelect = page.getByLabel('Assembly Constituency');
      await page.waitForFunction(
        () => {
          const labels = Array.from(document.querySelectorAll('label'));
          const acLabel = labels.find(l => l.innerText?.includes('Assembly Constituency'));
          const select = acLabel ? document.getElementById(acLabel.htmlFor) || acLabel.querySelector('select') : null;
          return select && select.options.length > 1;
        },
        null,
        { timeout: 15000 }
      ).catch(() => {});

      await page.waitForTimeout(1000);

      // Extract all ACs
      const acElements = await acSelect.locator('option').all();
      const acList = [];
      for (const opt of acElements) {
        const value = await opt.getAttribute('value');
        const text = (await opt.textContent())?.trim();
        if (value && value !== '' && value !== '0' && !text?.toLowerCase().includes('select')) {
          acList.push({ value, label: text });
        }
      }

      console.log(`📋 Found ${acList.length} Assembly Constituencies in ${district.label}`);

      // 3. Loop through each Assembly Constituency
      for (let aIdx = 0; aIdx < acList.length; aIdx++) {
        const ac = acList[aIdx];

        console.log(`\n------------------------------------------------------`);
        console.log(`▶️ [AC ${aIdx + 1}/${acList.length}] Checking: ${ac.label} (${ac.value})`);
        console.log(`------------------------------------------------------`);

        // Determine date range
        const dateInput = page.getByRole('textbox', { name: 'Generation Date' });
        const calendarMin = await dateInput.getAttribute('min');
        const calendarMax = await dateInput.getAttribute('max');

        const effectiveStart = START_DATE || calendarMin || '2026-08-27';
        const effectiveEnd = END_DATE || calendarMax;
        const datesToProcess = generateDateRange(effectiveStart, effectiveEnd || effectiveStart);

        // 4. Loop through each Date
        for (let dateIdx = 0; dateIdx < datesToProcess.length; dateIdx++) {
          const currentDate = datesToProcess[dateIdx];

          // Check skipped districts
          const skippedDistricts = SKIP_DISTRICTS_BY_DATE[currentDate] || [];
          const isSkipped = skippedDistricts.includes(district.value) ||
                            skippedDistricts.some(s => district.label.toLowerCase().includes(s.toLowerCase()));
          if (isSkipped) {
            console.log(`⏩ [AC: ${ac.label}] Date ${currentDate} skipped for District ${district.label}`);
            continue;
          }

          // Check if report already downloaded
          if (SKIP_EXISTING && fs.existsSync(targetDir)) {
            const matchingFiles = fs.readdirSync(targetDir).filter(f =>
              f.endsWith('.pdf') && f.includes(`-${ac.value}-`) && f.includes(currentDate)
            );
            if (matchingFiles.length > 0) {
              console.log(`⏩ [AC ${aIdx + 1}/${acList.length}] [Date ${dateIdx + 1}/${datesToProcess.length}: ${currentDate}] PDF already exists. Skipping.`);
              continue;
            }
          }

          console.log(`\n  👉 [PROCESSING] Date ${currentDate} -> AC: ${ac.label}`);

          // Re-ensure selections
          const currentAcVal = await page.getByLabel('Assembly Constituency').inputValue().catch(() => '');
          if (currentAcVal !== ac.value) {
            await page.getByLabel('Assembly Constituency').selectOption(ac.value);
            await page.waitForTimeout(300);
          }
          const currentFormVal = await page.getByLabel('Select Form Type').inputValue().catch(() => '');
          if (currentFormVal !== FORM_TYPE) {
            await page.getByLabel('Select Form Type').selectOption(FORM_TYPE);
            await page.waitForTimeout(300);
          }

          // Fill Generation Date
          await dateInput.fill(currentDate);
          await page.waitForTimeout(300);

          const captchaInput = page.locator('input[name="captcha"]');
          const captchaImgLocator = getCaptchaImgLocator(page);
          const refreshBtnLocator = getRefreshBtnLocator(page);

          let downloadSuccess = false;
          let lastFailedSrc = null;

          // Captcha attempt loop (with retries if invalid)
          for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
            if (attempt > 1) {
              console.log(`  🔄 [Attempt ${attempt}/${MAX_CAPTCHA_RETRIES}] Refreshing CAPTCHA and retrying...`);

              // Clear previous input
              await captchaInput.fill('');

              // If the site didn't auto-refresh after invalid attempt, click refresh button
              const currentSrcBeforeRefresh = await captchaImgLocator.getAttribute('src').catch(() => null);
              if (currentSrcBeforeRefresh === lastFailedSrc && await refreshBtnLocator.isVisible().catch(() => false)) {
                await refreshBtnLocator.click().catch(() => {});
              }

              // Wait until captcha image src is confirmed to be NEW
              await waitForCaptchaSrcToChange(page, lastFailedSrc, 8000);
              await page.waitForTimeout(400); // Allow image render to settle
            }

            // Step 1: Capture current CAPTCHA image
            const tempTimestamp = Date.now();
            const tempImagePath = path.join(TEMP_CAPTCHA_DIR, `temp_${ac.value}_${tempTimestamp}.jpg`);
            const capturedSrc = await saveCaptchaImage(page, tempImagePath);

            // Step 2: Model prediction (in-memory worker ~0.15s, fallback CLI)
            let predictedText = '';
            try {
              if (worker.isReady) {
                predictedText = await worker.predict(tempImagePath);
              } else {
                predictedText = await predictFallbackCLI(tempImagePath);
              }
            } catch (modelErr) {
              console.warn(`  ⚠️ Model inference warning: ${modelErr.message}`);
              try { predictedText = await predictFallbackCLI(tempImagePath); } catch {}
            }

            // If model output is empty or less than 6 characters, refresh captcha and predict again
            if (!predictedText || predictedText.length < 6) {
              console.log(`  ⚠️ Model provided "${predictedText}" (< 6 characters: ${predictedText ? predictedText.length : 0}). Refreshing CAPTCHA...`);
              if (fs.existsSync(tempImagePath)) {
                try { fs.unlinkSync(tempImagePath); } catch {}
              }

              lastFailedSrc = capturedSrc;
              if (await refreshBtnLocator.isVisible().catch(() => false)) {
                await refreshBtnLocator.click().catch(() => {});
              }
              await waitForCaptchaSrcToChange(page, lastFailedSrc, 8000);
              await page.waitForTimeout(400);
              continue;
            }

            console.log(`  ✨ Model Prediction: "${predictedText}"`);

            // Verify the captcha image on the page did NOT change while the model was predicting
            const currentSrcAfterPred = await captchaImgLocator.getAttribute('src').catch(() => null);
            if (currentSrcAfterPred && capturedSrc && currentSrcAfterPred !== capturedSrc) {
              console.log(`  ⚠️ CAPTCHA refreshed on page while model was predicting! Retrying with new image...`);
              try { fs.unlinkSync(tempImagePath); } catch {}
              continue;
            }

            // Step 3: Type predicted text into captcha input field character by character
            await fillCaptchaOneByOne(page, captchaInput, predictedText, TYPING_DELAY_MS);
            await page.waitForTimeout(400);

            // Step 4: Click Download button and await download event
            lastFailedSrc = capturedSrc;
            try {
              const downloadPromise = page.waitForEvent('download', { timeout: 12000 });
              await page.getByRole('button', { name: 'Download' }).click();
              const download = await downloadPromise;

              const filename = download.suggestedFilename();
              const saveFilePath = path.join(targetDir, filename);
              await download.saveAs(saveFilePath);
              console.log(`  ✅ Successfully downloaded PDF: ${saveFilePath}`);
              downloadSuccess = true;

              // =========================================================================
              // 📸 ONLY SAVE IMAGE & MAKE LABELS IF FILE DOWNLOAD WAS SUCCESSFUL!
              // =========================================================================
              const nextIndex = getNextCaptchaIndex(allRecords);
              const permanentFilename = `captcha_${String(nextIndex).padStart(3, '0')}.jpg`;
              const permanentImagePath = path.join(IMAGES_DIR, permanentFilename);

              // Copy temporary image to permanent dataset
              if (fs.existsSync(tempImagePath)) {
                fs.copyFileSync(tempImagePath, permanentImagePath);
                try { fs.unlinkSync(tempImagePath); } catch {}
              } else if (capturedSrc && capturedSrc.startsWith('data:image')) {
                const base64Data = capturedSrc.replace(/^data:image\/\w+;base64,/, '');
                fs.writeFileSync(permanentImagePath, Buffer.from(base64Data, 'base64'));
              }

              // Update records and labels JSON
              const record = {
                id: nextIndex,
                image: permanentFilename,
                input: predictedText,
                district: district.label,
                districtCode: district.value,
                ac: ac.label,
                acCode: ac.value,
                date: currentDate,
                imagePath: permanentImagePath,
                timestamp: new Date().toISOString()
              };

              allRecords.push(record);
              labelMap[permanentFilename] = predictedText;

              fs.writeFileSync(CAPTCHA_DATA_JSON, JSON.stringify(allRecords, null, 2), 'utf-8');
              fs.writeFileSync(CAPTCHA_LABELS_JSON, JSON.stringify(labelMap, null, 2), 'utf-8');
              syncKpiHtml(allRecords);

              console.log(`  🏷️ Saved verified image: ${permanentFilename} ➔ Label: "${predictedText}" [Total: ${allRecords.length}]`);

              break; // Success! Exit retry loop
            } catch (downloadErr) {
              console.warn(`  ⚠️ Download failed or invalid captcha (attempt ${attempt}/${MAX_CAPTCHA_RETRIES}): ${downloadErr.message}`);

              // Clean up temporary image - DO NOT save to data/captcha_images, DO NOT add to labels!
              if (fs.existsSync(tempImagePath)) {
                try { fs.unlinkSync(tempImagePath); } catch {}
              }

              await page.waitForTimeout(800);
            }
          }

          if (!downloadSuccess) {
            console.error(`  ❌ Failed to download report for ${ac.label} (${currentDate}) after ${MAX_CAPTCHA_RETRIES} attempts.`);
          }

          await page.waitForTimeout(1000);
        }

        console.log(`✔️ Finished checking AC: ${ac.label}`);
      }

      console.log(`\n🎉 Finished District: ${district.label}`);
    }

    console.log('\n🏁 Finished processing all Districts, Assembly Constituencies, and Dates!');
  } finally {
    // Always stop the in-memory Python worker process when the test concludes
    worker.stop();
  }
});
