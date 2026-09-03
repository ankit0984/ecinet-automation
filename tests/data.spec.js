import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// ======================== CONFIGURATION ========================
// Set to null to download ALL districts, a single district code like 'S1902', or an array like ['S1904', 'S1911']
const TARGET_DISTRICT = ["S1917"]; 

// Specify districts to skip for specific dates
// Format: { 'YYYY-MM-DD': ['DISTRICT_CODE_OR_NAME', ...] }
const SKIP_DISTRICTS_BY_DATE = {
  '2026-08-27': ['S1902'], // S1902 = Amritsar
};

const FORM_TYPE = 'form10';

// Start date to begin downloading from
const START_DATE = '2026-08-27';

// End date: if null, automatically uses the maximum allowed (non-disabled) date from the calendar
const END_DATE = null;

// Base directory where files are downloaded (e.g. 'data')
const BASE_DOWNLOAD_DIR = 'data';

// Skip if a PDF report for this AC and date already exists in the destination folder
const SKIP_EXISTING = true; 
// ===============================================================

// Helper to remove illegal characters from folder names
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// Helper: Generate array of dates between start and end (inclusive) without timezone issues
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

test('download form 10 reports organized by district, assembly, and date', async ({ page }) => {
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

  // Filter if a specific district or list of districts is targeted
  if (TARGET_DISTRICT) {
    if (Array.isArray(TARGET_DISTRICT)) {
      if (TARGET_DISTRICT.length > 0) {
        districtList = districtList.filter(d => TARGET_DISTRICT.includes(d.value) || TARGET_DISTRICT.includes(d.label));
      }
    } else {
      districtList = districtList.filter(d => d.value === TARGET_DISTRICT || d.label === TARGET_DISTRICT);
    }
  }

  console.log(`\n======================================================`);
  console.log(`🏛️ Found ${districtList.length} District(s) to process:`);
  districtList.forEach((d, i) => console.log(`   ${i + 1}. [${d.value}] ${d.label}`));
  console.log(`======================================================\n`);

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

      console.log(`\n------------------------------------------------------`);
      console.log(`▶️ [AC ${aIdx + 1}/${acList.length}] Processing: ${ac.label} (${ac.value})`);
      console.log(`------------------------------------------------------`);

      // Select AC
      await page.getByLabel('Assembly Constituency').selectOption(ac.value);
      await page.waitForTimeout(500);

      // Select Form Type
      await page.getByLabel('Select Form Type').selectOption(FORM_TYPE);
      await page.waitForTimeout(300);

      // Determine available dates from calendar min and max attributes
      const dateInput = page.getByRole('textbox', { name: 'Generation Date' });
      const calendarMin = await dateInput.getAttribute('min');
      const calendarMax = await dateInput.getAttribute('max');

      const effectiveStart = START_DATE || calendarMin || '2026-08-27';
      const effectiveEnd = END_DATE || calendarMax;

      if (!effectiveEnd) {
        console.warn(`⚠️ Could not detect max calendar date for ${ac.label}.`);
      }

      const datesToProcess = generateDateRange(effectiveStart, effectiveEnd || effectiveStart);
      console.log(`📅 Date range for ${ac.label}: ${effectiveStart} to ${effectiveEnd} (${datesToProcess.length} dates)`);

      // 4. Loop through each Date for this Assembly Constituency
      for (let dateIdx = 0; dateIdx < datesToProcess.length; dateIdx++) {
        const currentDate = datesToProcess[dateIdx];

        // Check if district is skipped for this date
        const skippedDistricts = SKIP_DISTRICTS_BY_DATE[currentDate] || [];
        const isSkipped = skippedDistricts.includes(district.value) ||
                          skippedDistricts.some(s => district.label.toLowerCase().includes(s.toLowerCase()));
        if (isSkipped) {
          console.log(`⏩ [AC: ${ac.label}] Date ${currentDate} skipped for District ${district.label}`);
          continue;
        }

        // Check if file already exists in district folder for this AC and Date
        if (SKIP_EXISTING && fs.existsSync(targetDir)) {
          const existingFiles = fs.readdirSync(targetDir).filter(f =>
            f.endsWith('.pdf') && f.includes(`-${ac.value}-`) && f.includes(currentDate)
          );
          if (existingFiles.length > 0) {
            console.log(`⏩ [AC ${aIdx + 1}/${acList.length}] [Date ${dateIdx + 1}/${datesToProcess.length}: ${currentDate}] Already downloaded: ${existingFiles[0]}`);
            continue;
          }
        }

        console.log(`\n  🗓️ [Date ${dateIdx + 1}/${datesToProcess.length}] ${currentDate} -> ${ac.label}`);

        // Re-ensure AC & Form Type selections in case form reset
        const currentAcVal = await page.getByLabel('Assembly Constituency').inputValue().catch(() => '');
        if (currentAcVal !== ac.value) {
          await page.getByLabel('Assembly Constituency').selectOption(ac.value);
          await page.waitForTimeout(200);
        }
        const currentFormVal = await page.getByLabel('Select Form Type').inputValue().catch(() => '');
        if (currentFormVal !== FORM_TYPE) {
          await page.getByLabel('Select Form Type').selectOption(FORM_TYPE);
          await page.waitForTimeout(200);
        }

        // Fill Generation Date
        await dateInput.fill(currentDate);
        await page.waitForTimeout(300);

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
          console.log(`  ✅ Successfully saved: ${saveFilePath}`);
        } catch (err) {
          console.error(`  ⚠️ Could not complete download for ${ac.label} (${currentDate}): ${err.message}`);
        }

        await page.waitForTimeout(1000);
      }

      console.log(`✔️ Finished all dates for AC: ${ac.label}`);
    }

    console.log(`\n🎉 Finished all Assembly Constituencies in District: ${district.label}`);
  }

  console.log('\n🏁 Finished processing all Districts, Assembly Constituencies, and Dates!');
});
