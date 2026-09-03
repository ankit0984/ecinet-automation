import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// ======================== CONFIGURATION ========================
// 1. DATE CONFIGURATION
// Start and End dates for calendar generation:
const START_DATE = '2026-08-27'; // YYYY-MM-DD
const END_DATE   = '2026-08-30'; // YYYY-MM-DD (inclusive)

// Or provide specific custom dates (leave empty [] to use START_DATE & END_DATE):
const CUSTOM_DATES = []; // e.g. ['2026-08-27', '2026-08-28']

// Waiting time in minutes when all districts for a date are finished before advancing to next date:
const WAIT_MINUTES_BETWEEN_DATES = 2;

// 2. DISTRICT & FORM CONFIGURATION
// Set to null to process ALL districts, or specify a district code like 'S1902'
const TARGET_DISTRICT = null; 

// Districts to skip for specific dates
// Format: { 'YYYY-MM-DD': ['DISTRICT_CODE_OR_NAME', ...] }
const SKIP_DISTRICTS_BY_DATE = {
  '2026-08-27': ['S1902'], // S1902 = Amritsar
};

const FORM_TYPE = 'form10';

// Base directory where files are downloaded (e.g. 'data')
const BASE_DOWNLOAD_DIR = 'data';

// Skip downloading if a PDF report already exists in the destination folder
const SKIP_EXISTING = true; 
// ===============================================================

// Helper: Generate array of dates between start and end (inclusive)
function generateDateRange(startStr, endStr) {
  const dates = [];
  let current = new Date(startStr);
  const end = new Date(endStr);
  while (current <= end) {
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Helper: Clean illegal filename characters
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// Helper: Check if district is skipped on a specific date
function isDistrictSkippedForDate(districtCode, districtLabel, date) {
  const toSkip = SKIP_DISTRICTS_BY_DATE[date] || [];
  return toSkip.includes(districtCode) || toSkip.some(s => districtLabel.toLowerCase().includes(s.toLowerCase()));
}

// Helper: Safely set React controlled Select
async function setReactSelect(page, label, value) {
  const select = page.getByLabel(label);
  await select.selectOption(value);
  await page.evaluate(({ lbl, val }) => {
    const labels = Array.from(document.querySelectorAll('label'));
    const targetLabel = labels.find(l => l.innerText && l.innerText.toLowerCase().includes(lbl.toLowerCase()));
    const el = targetLabel ? document.getElementById(targetLabel.htmlFor) || targetLabel.querySelector('select') : null;
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter ? setter.call(el, val) : (el.value = val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { lbl: label, val: value });
  await select.dispatchEvent('change');
}

// Helper: Safely set React controlled Date input
async function setReactDateInput(page, dateValue) {
  const dateInput = page.getByRole('textbox', { name: 'Generation Date' });
  await dateInput.click();
  await page.evaluate((val) => {
    const labels = Array.from(document.querySelectorAll('label'));
    const dLabel = labels.find(l => l.innerText && l.innerText.toLowerCase().includes('generation date'));
    const input = dLabel ? document.getElementById(dLabel.htmlFor) || dLabel.querySelector('input') : document.querySelector('input[name*="date" i]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(input, val) : (input.value = val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, dateValue);
  await dateInput.fill(dateValue);
  await dateInput.dispatchEvent('input');
  await dateInput.dispatchEvent('change');
  await dateInput.press('Enter');
}

// Helper: Countdown timer between dates
async function waitWithCountdown(minutes) {
  const totalSeconds = Math.round(minutes * 60);
  console.log(`\n⏳ Finished all districts for this date! Waiting ${minutes} minute(s) before advancing to next date...`);
  for (let remaining = totalSeconds; remaining > 0; remaining -= 5) {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    process.stdout.write(`\r⏳ Next date in: ${mins}m ${secs}s... `);
    await new Promise(res => setTimeout(res, Math.min(5, remaining) * 1000));
  }
  console.log(`\n🚀 Moving to next date!\n`);
}

test('download form 10 reports organized by date, district, and assembly constituency', async ({ page }) => {
  test.setTimeout(0); // Disable timeout for manual captcha entry

  const datesList = CUSTOM_DATES.length > 0 
    ? CUSTOM_DATES 
    : generateDateRange(START_DATE, END_DATE);

  console.log(`\n======================================================`);
  console.log(`📅 Planned Calendar Dates (${datesList.length}):`);
  datesList.forEach((d, i) => console.log(`   ${i + 1}. ${d}`));
  console.log(`======================================================\n`);

  // First page load to discover all Districts
  await page.goto('https://voters.eci.gov.in/download-statutory-report?stateCode=S19');
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

  const districtSelect = page.getByLabel('District');
  const districtElements = await districtSelect.locator('option').all();
  let districtList = [];
  for (const opt of districtElements) {
    const value = await opt.getAttribute('value');
    const text = (await opt.textContent())?.trim();
    if (value && value !== '' && value !== '0' && !text?.toLowerCase().includes('select')) {
      districtList.push({ value, label: text });
    }
  }

  if (TARGET_DISTRICT) {
    districtList = districtList.filter(d => d.value === TARGET_DISTRICT);
  }

  console.log(`🏛️ Found ${districtList.length} District(s) to process.`);

  // ==================== 1. OUTER LOOP: DATES ====================
  for (let dateIdx = 0; dateIdx < datesList.length; dateIdx++) {
    const currentDate = datesList[dateIdx];
    const cleanDate = sanitizeName(currentDate);

    console.log(`\n######################################################`);
    console.log(`📅 [Date ${dateIdx + 1}/${datesList.length}] Processing Calendar Date: ${currentDate}`);
    console.log(`######################################################\n`);

    // ==================== 2. MIDDLE LOOP: DISTRICTS ====================
    for (let dIdx = 0; dIdx < districtList.length; dIdx++) {
      const district = districtList[dIdx];
      const cleanDistrictName = sanitizeName(district.label);

      // Check if this district is skipped on this date
      if (isDistrictSkippedForDate(district.value, district.label, currentDate)) {
        console.log(`⏩ Skipping [District: ${district.label}] for date ${currentDate}`);
        continue;
      }

      console.log(`\n======================================================`);
      console.log(`🏛️ [Date: ${currentDate}] [District ${dIdx + 1}/${districtList.length}] ${district.label} (${district.value})`);
      console.log(`======================================================`);

      // Fresh page load for this district to fetch accurate AC list
      await page.goto('https://voters.eci.gov.in/download-statutory-report?stateCode=S19');
      await page.waitForTimeout(500);

      // Select District
      await setReactSelect(page, 'District', district.value);

      // Wait for AC options to populate
      await page.waitForFunction(
        () => {
          const select = document.querySelector('select[name="constituency"], #constituency');
          return select && select.options.length > 1;
        },
        null,
        { timeout: 15000 }
      ).catch(() => {});
      await page.waitForTimeout(1000);

      // Extract all ACs for this district
      const acSelect = page.getByLabel('Assembly Constituency');
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

      // ==================== 3. INNER LOOP: ASSEMBLY CONSTITUENCIES ====================
      for (let aIdx = 0; aIdx < acList.length; aIdx++) {
        const ac = acList[aIdx];
        const cleanAcName = sanitizeName(ac.label);

        // Path: <BASE_DOWNLOAD_DIR> / <District Name> / <Assembly Name> / <Date>
        const targetDir = path.join(BASE_DOWNLOAD_DIR, cleanDistrictName, cleanAcName, cleanDate);

        // Check if report already exists in date-wise folder
        if (SKIP_EXISTING && fs.existsSync(targetDir)) {
          const existingFiles = fs.readdirSync(targetDir).filter(f => f.endsWith('.pdf'));
          if (existingFiles.length > 0) {
            console.log(`⏩ [AC ${aIdx + 1}/${acList.length}] Skipping ${ac.label} (already exists: ${existingFiles[0]})`);
            continue;
          }
        }

        console.log(`\n▶️ [AC ${aIdx + 1}/${acList.length}] [Date: ${currentDate}] Processing: ${ac.label} (${ac.value})`);

        // Navigate fresh to avoid any stale form state from previous download
        await page.goto('https://voters.eci.gov.in/download-statutory-report?stateCode=S19');
        await page.waitForTimeout(500);

        // 1. Select District
        await setReactSelect(page, 'District', district.value);

        // 2. Wait for AC option to appear and select it
        await page.waitForFunction(
          (val) => {
            const sel = document.querySelector('select[name="constituency"], #constituency');
            return sel && Array.from(sel.options).some(o => o.value === val);
          },
          ac.value,
          { timeout: 15000 }
        ).catch(() => {});
        await setReactSelect(page, 'Assembly Constituency', ac.value);
        await page.waitForTimeout(400);

        // 3. Select Form Type
        await setReactSelect(page, 'Select Form Type', FORM_TYPE);
        await page.waitForTimeout(300);

        // 4. Set Generation Date (ensures React internal state is updated)
        await setReactDateInput(page, currentDate);
        await page.waitForTimeout(300);

        // 5. Clear & focus CAPTCHA
        const captchaInput = page.locator('input[name="captcha"]');
        await captchaInput.fill('');
        await captchaInput.focus();

        console.log(`📋 Form confirmed: [${district.label}] -> [${ac.label}] -> Date: [${currentDate}]`);
        console.log(`👉 Enter 6-character CAPTCHA in browser...`);

        // Wait until user types 6 characters
        await page.waitForFunction(
          () => {
            const input = document.querySelector('input[name="captcha"]');
            return input && input.value.trim().length >= 6;
          },
          null,
          { timeout: 0 }
        );

        // Debounce before trigger
        await page.waitForTimeout(500);

        // Trigger Download and handle file
        try {
          const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
          await page.getByRole('button', { name: 'Download' }).click();
          const download = await downloadPromise;

          const filename = download.suggestedFilename();

          // Extract date from filename if present (e.g. form10-S1919-102-2026-08-27-report.pdf)
          const dateMatch = filename.match(/\d{4}-\d{2}-\d{2}/);
          const fileDate = dateMatch ? dateMatch[0] : cleanDate;

          // Save into the actual date directory matching the file
          const saveFolder = path.join(BASE_DOWNLOAD_DIR, cleanDistrictName, cleanAcName, fileDate);
          fs.mkdirSync(saveFolder, { recursive: true });

          const saveFilePath = path.join(saveFolder, filename);
          await download.saveAs(saveFilePath);
          console.log(`✅ Successfully saved: ${saveFilePath}`);
        } catch (err) {
          console.error(`⚠️ Could not complete download for ${ac.label} (${currentDate}): ${err.message}`);
        }

        await page.waitForTimeout(1000);
      }
    }

    console.log(`\n✅ Completed all districts for Date: ${currentDate}!`);

    // If there are more dates remaining, wait for the configured minutes
    if (dateIdx < datesList.length - 1 && WAIT_MINUTES_BETWEEN_DATES > 0) {
      await waitWithCountdown(WAIT_MINUTES_BETWEEN_DATES);
    }
  }

  console.log('\n🎉 Finished processing all Dates, Districts, and Assembly Constituencies!');
});
