import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// ======================== CONFIGURATION ========================
// Set to null to download ALL districts, or specify a district code like 'S1902'
const TARGET_DISTRICT = null; 

// Specify districts to skip for specific dates
// Format: { 'YYYY-MM-DD': ['DISTRICT_CODE_OR_NAME', ...] }
const SKIP_DISTRICTS_BY_DATE = {
  '2026-08-27': ['S1902'], // S1902 = Amritsar
};

const FORM_TYPE = 'form10';
const GENERATION_DATE = '2026-08-27';
// Base directory where files are downloaded (e.g. 'data')
const BASE_DOWNLOAD_DIR = 'data';

// Skip if a PDF report already exists in the destination folder
const SKIP_EXISTING = true; 
// ===============================================================

// Helper to remove illegal characters from folder names
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

test('download form 10 reports organized by district and assembly constituency', async ({ page }) => {
  test.setTimeout(0); // Disable timeout for manual captcha entry

  await page.goto('https://voters.eci.gov.in/download-statutory-report?stateCode=S19');

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
    { timeout: 15000 }
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

  // Filter if a specific district is targeted
  if (TARGET_DISTRICT) {
    districtList = districtList.filter(d => d.value === TARGET_DISTRICT);
  }

  // Filter out skipped districts for the selected generation date
  const districtsToSkip = SKIP_DISTRICTS_BY_DATE[GENERATION_DATE] || [];
  if (districtsToSkip.length > 0) {
    districtList = districtList.filter(d => {
      const isSkipped = districtsToSkip.includes(d.value) || 
                        districtsToSkip.some(s => d.label.toLowerCase().includes(s.toLowerCase()));
      if (isSkipped) {
        console.log(`⏩ Skipping District ${d.label} (${d.value}) for date ${GENERATION_DATE}`);
      }
      return !isSkipped;
    });
  }

  console.log(`\n======================================================`);
  console.log(`🏛️ Found ${districtList.length} District(s) to process:`);
  districtList.forEach((d, i) => console.log(`   ${i + 1}. [${d.value}] ${d.label}`));
  console.log(`======================================================\n`);

  // 2. Loop through each District
  for (let dIdx = 0; dIdx < districtList.length; dIdx++) {
    const district = districtList[dIdx];
    const cleanDistrictName = sanitizeName(district.label);

    console.log(`\n======================================================`);
    console.log(`🏛️ [District ${dIdx + 1}/${districtList.length}] ${district.label} (${district.value})`);
    console.log(`======================================================`);

    // Select District
    await page.getByLabel('District').selectOption(district.value);

    // Wait for Assembly Constituency dropdown to update for this district
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

    // Extract all Assembly Constituencies
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
      const cleanAcName = sanitizeName(ac.label);

      // Construct directory path: <BASE_DOWNLOAD_DIR>/<district_name>/<assembly_constituency_name>
      const targetDir = path.join(BASE_DOWNLOAD_DIR, cleanDistrictName, cleanAcName);

      // Check if file already exists
      if (SKIP_EXISTING && fs.existsSync(targetDir)) {
        const existingFiles = fs.readdirSync(targetDir).filter(f => f.endsWith('.pdf'));
        if (existingFiles.length > 0) {
          console.log(`⏩ [${aIdx + 1}/${acList.length}] Skipping AC: ${ac.label} (already downloaded: ${existingFiles[0]})`);
          continue;
        }
      }

      console.log(`\n▶️ [AC ${aIdx + 1}/${acList.length}] Processing: ${ac.label} (${ac.value})`);
      console.log(`📁 Target folder: ${targetDir}`);

      // Ensure directory exists
      fs.mkdirSync(targetDir, { recursive: true });

      // Select AC
      await page.getByLabel('Assembly Constituency').selectOption(ac.value);
      await page.waitForTimeout(500);

      // Select Form Type
      await page.getByLabel('Select Form Type').selectOption(FORM_TYPE);
      await page.waitForTimeout(300);

      // Fill Generation Date
      const dateInput = page.getByRole('textbox', { name: 'Generation Date' });
      await dateInput.fill(GENERATION_DATE);
      await page.waitForTimeout(300);

      // Clear & focus CAPTCHA input
      const captchaInput = page.locator('input[name="captcha"]');
      await captchaInput.fill('');
      await captchaInput.focus();

      console.log(`👉 Enter 6-character CAPTCHA for [${district.label} -> ${ac.label}] in browser...`);

      // Wait until user types 6 characters
      await page.waitForFunction(
        () => {
          const input = document.querySelector('input[name="captcha"]');
          return input && input.value.trim().length >= 6;
        },
        null,
        { timeout: 0 }
      );

      // Small debounce
      await page.waitForTimeout(500);

      // Download file
      try {
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        await page.getByRole('button', { name: 'Download' }).click();
        const download = await downloadPromise;

        const filename = download.suggestedFilename();
        const saveFilePath = path.join(targetDir, filename);
        await download.saveAs(saveFilePath);
        console.log(`✅ Successfully saved: ${saveFilePath}`);
      } catch (err) {
        console.error(`⚠️ Could not complete download for ${ac.label}: ${err.message}`);
      }

      await page.waitForTimeout(1500);
    }
  }

  console.log('\n🎉 Finished processing all Districts and Assembly Constituencies!');
});
