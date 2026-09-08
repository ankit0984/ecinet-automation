import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// ======================== CONFIGURATION ========================
// Target district: null for all districts, or specific array like ['S1917'] (taken from data.spec.js)
// const TARGET_DISTRICT = [
//   "S1902",
//   "S1919",
//   "S1916",
//   "S1915",
//   "S1910",
//   "S1923",
//   "S1913",
//   "S1901",
//   "S1906",
//   "S1905",
//   "S1904",
//   "S1911",
//   "S1921",
//   "S1917",
//   "S1912",
//   "S1922",
//   "S1920",
//   "S1908",
//   "S1909",
//   "S1918",
//   "S1907",
//   "S1914",
//   "S1903"
// ];
const TARGET_DISTRICT = [  "S1902", "S1919", "S1916", "S1915", "S1910", "S1923",]

// Districts to skip for specific dates
const SKIP_DISTRICTS_BY_DATE = {
  // '2026-08-27': ['S1902'], // S1902 = Amritsar
};

const FORM_TYPE = 'form09';


// Dates configuration
const START_DATE = '2026-09-05';
const END_DATE = null; // null uses maximum allowed date from calendar

// Destination directories
const BASE_DOWNLOAD_DIR = 'data';
const IMAGES_DIR = path.join('data', 'captcha_images');
const CAPTCHA_DATA_JSON = path.join('data', 'captcha_data.json');
const CAPTCHA_LABELS_JSON = path.join('data', 'captcha_labels.json');

// Skip if PDF or record already exists
const SKIP_EXISTING = true;

// Portal page URL
const TARGET_PAGE_URL = 'https://voters.eci.gov.in/download-statutory-report?stateCode=S19';
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

// Helper: Get the next sequential captcha index
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

// =========================================================================
// 🚀 CAPTCHA Collector & Statutory Report Downloader
// =========================================================================
test('Form Automation, Report Downloader & CAPTCHA Collector', async ({ page }) => {
  test.setTimeout(0); // Disable timeout for user captcha typing

  // Ensure directories exist
  if (!fs.existsSync(BASE_DOWNLOAD_DIR)) fs.mkdirSync(BASE_DOWNLOAD_DIR, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // Clean up any stale queue files from older versions
  const staleQueue = path.join('data', '.captcha_queue.jsonl');
  if (fs.existsSync(staleQueue)) {
    try { fs.unlinkSync(staleQueue); } catch {}
  }

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
  console.log(`🚀 Started Form Automation & CAPTCHA Collector`);
  console.log(`📋 Target Districts: ${JSON.stringify(TARGET_DISTRICT)}`);
  console.log(`📊 Existing CAPTCHA records: ${allRecords.length}`);
  console.log(`🌐 Target Portal: ${TARGET_PAGE_URL}`);
  console.log(`======================================================\n`);

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

        // =================================================================
        // 🔍 CHECK PHASE: Check if data is already present
        // NO CAPTCHA captured, NO input asked, NO files replicated while checking!
        // =================================================================
        let isAlreadyDownloaded = false;
        if (SKIP_EXISTING && fs.existsSync(targetDir)) {
          const matchingFiles = fs.readdirSync(targetDir).filter(f =>
            f.endsWith('.pdf') && f.includes(`-${ac.value}-`) && f.includes(currentDate)
          );
          if (matchingFiles.length > 0) {
            isAlreadyDownloaded = true;
          }
        }

        // Also check if already recorded in captcha_data.json
        const isAlreadyRecorded = allRecords.some(r =>
          String(r.districtCode) === String(district.value) &&
          String(r.acCode) === String(ac.value) &&
          String(r.date) === String(currentDate)
        );

        if (isAlreadyDownloaded && isAlreadyRecorded) {
          console.log(`⏩ [AC ${aIdx + 1}/${acList.length}] [Date ${dateIdx + 1}/${datesToProcess.length}: ${currentDate}] Already present in folder & dataset. Skipping.`);
          continue;
        }

        if (isAlreadyDownloaded && !isAlreadyRecorded) {
          console.log(`⏩ [AC ${aIdx + 1}/${acList.length}] [Date ${dateIdx + 1}/${datesToProcess.length}: ${currentDate}] PDF already exists in ${cleanDistrictName}/. Skipping.`);
          continue;
        }

        // =================================================================
        // ✍️ CAPTURE PHASE: Data is missing -> Start capturing input and captcha
        // =================================================================
        console.log(`\n  👉 [NEW DATA REQUIRED] Date ${currentDate} -> ${ac.label}`);

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

        // Capture current CAPTCHA image element
        const captchaImgLocator = page.locator([
          'img[alt="Captcha"]',
          'img[alt*="captcha" i]:not([alt*="refrsh"]):not([alt*="refresh"]):not([alt*="QR"])'
        ].join(', ')).first();
        await captchaImgLocator.waitFor({ state: 'visible', timeout: 15000 });
        const captchaImageSrc = await captchaImgLocator.getAttribute('src');

        // Clear & focus CAPTCHA input
        const captchaInput = page.locator('input[name="captcha"]');
        await captchaInput.fill('');
        await captchaInput.focus();

        console.log(`  👉 Enter 6-character CAPTCHA for [${district.label} -> ${ac.label} -> ${currentDate}] in browser...`);

        // Wait until user types 6 characters
        await page.waitForFunction(
          () => {
            const input = document.querySelector('input[name="captcha"]');
            return input && input.value.trim().length >= 6;
          },
          null,
          { timeout: 0 }
        );

        // Read the user's exact typed captcha input!
        const userEnteredCaptcha = (await captchaInput.inputValue()).trim();
        console.log(`  ✍️ Captured user input: "${userEnteredCaptcha}"`);

        // Small debounce before download
        await page.waitForTimeout(500);

        // Download statutory PDF report
        let downloadSuccess = false;
        try {
          const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
          await page.getByRole('button', { name: 'Download' }).click();
          const download = await downloadPromise;

          const filename = download.suggestedFilename();
          const saveFilePath = path.join(targetDir, filename);
          await download.saveAs(saveFilePath);
          console.log(`  ✅ Successfully saved PDF: ${saveFilePath}`);
          downloadSuccess = true;
        } catch (err) {
          console.error(`  ⚠️ Could not complete PDF download for ${ac.label} (${currentDate}): ${err.message}`);
        }

        // Save CAPTCHA image and record ONLY after user input is confirmed
        if (captchaImageSrc && userEnteredCaptcha) {
          const nextIndex = getNextCaptchaIndex(allRecords);
          const filename = `captcha_${String(nextIndex).padStart(3, '0')}.jpg`;
          const imagePath = path.join(IMAGES_DIR, filename);

          // 1. Decode and save image
          const base64Data = captchaImageSrc.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));

          // 2. Add entry to records
          const record = {
            id: nextIndex,
            image: filename,
            input: userEnteredCaptcha,
            district: district.label,
            districtCode: district.value,
            ac: ac.label,
            acCode: ac.value,
            date: currentDate,
            imagePath: imagePath,
            timestamp: new Date().toISOString()
          };

          allRecords.push(record);
          labelMap[filename] = userEnteredCaptcha;

          // 3. Update JSON files immediately
          fs.writeFileSync(CAPTCHA_DATA_JSON, JSON.stringify(allRecords, null, 2), 'utf-8');
          fs.writeFileSync(CAPTCHA_LABELS_JSON, JSON.stringify(labelMap, null, 2), 'utf-8');
          syncKpiHtml(allRecords);

          console.log(`  📸 Stored ${filename} ➔ User Input: "${userEnteredCaptcha}" [Total records: ${allRecords.length}]`);
        }

        await page.waitForTimeout(1000);
      }

      console.log(`✔️ Finished checking AC: ${ac.label}`);
    }

    console.log(`\n🎉 Finished District: ${district.label}`);
  }

  console.log('\n🏁 Finished processing all Districts, Assembly Constituencies, and Dates!');
});
