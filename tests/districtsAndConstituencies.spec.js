import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// ======================== CONFIGURATION ========================
// State code: S19 (Punjab) by default, or configurable via env STATE_CODE
const STATE_CODE = process.env.STATE_CODE || 'S19';
const TARGET_PAGE_URL = `https://voters.eci.gov.in/download-statutory-report?stateCode=${STATE_CODE}`;

// Output JSON configuration
const OUTPUT_DIR = path.resolve('data');
const OUTPUT_FILE = process.env.OUTPUT_FILE || path.join(OUTPUT_DIR, `districts_and_constituencies_${STATE_CODE.toLowerCase()}.json`);
const DEFAULT_JSON_FILE = path.join(OUTPUT_DIR, 'districts_and_constituencies.json');
// ===============================================================

// Helper: Safely trigger React-controlled select change
async function setReactSelect(page, labelText, value) {
  const select = page.getByLabel(labelText);
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
  }, { lbl: labelText, val: value });
  await select.dispatchEvent('change').catch(() => {});
}

// Helper: Parse constituency number and name from label (e.g. "1 - Sujanpur" -> number: "1", name: "Sujanpur")
function parseConstituencyLabel(rawLabel, value) {
  const trimmed = (rawLabel || '').trim();
  const match = trimmed.match(/^(\d+)\s*[-:]\s*(.+)$/);
  if (match) {
    return {
      acNumber: match[1],
      acCode: value,
      acName: match[2].trim(),
      label: trimmed
    };
  }
  return {
    acNumber: value,
    acCode: value,
    acName: trimmed,
    label: trimmed
  };
}

test('extract district and assembly constituency data in JSON only', async ({ page }) => {
  test.setTimeout(180000); // 3 minutes timeout for complete extraction

  // Capture background API responses for ACs/districts if available
  const apiAcMap = new Map();
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (url.includes('constituency') || url.includes('acList') || url.includes('district')) {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('application/json')) {
          const json = await response.json();
          if (Array.isArray(json)) {
            apiAcMap.set(url, json);
          } else if (json && Array.isArray(json.data)) {
            apiAcMap.set(url, json.data);
          }
        }
      }
    } catch {}
  });

  // Navigate to target portal page
  await page.goto(TARGET_PAGE_URL, { waitUntil: 'commit', timeout: 60000 });

  // Wait for District dropdown to populate
  const districtSelect = page.getByLabel('District');
  await page.waitForFunction(
    () => {
      const labels = Array.from(document.querySelectorAll('label'));
      const dLabel = labels.find(l => l.innerText?.toLowerCase().includes('district'));
      const select = dLabel ? document.getElementById(dLabel.htmlFor) || dLabel.querySelector('select') : null;
      return select && select.options.length > 1;
    },
    null,
    { timeout: 30000 }
  );

  // Extract all District options from dropdown
  const districtElements = await districtSelect.locator('option').all();
  const districtList = [];
  for (const opt of districtElements) {
    const value = (await opt.getAttribute('value'))?.trim();
    const text = (await opt.textContent())?.trim();
    if (value && value !== '' && value !== '0' && !text?.toLowerCase().includes('select')) {
      districtList.push({ districtCode: value, districtName: text });
    }
  }

  // Iterate over each district and extract its Assembly Constituencies
  const resultData = {
    stateCode: STATE_CODE,
    extractedAt: new Date().toISOString(),
    totalDistricts: districtList.length,
    totalConstituencies: 0,
    districts: []
  };

  for (let i = 0; i < districtList.length; i++) {
    const dist = districtList[i];

    // Select the district
    await setReactSelect(page, 'District', dist.districtCode);

    // Wait for Assembly Constituency dropdown to update with options for this district
    const acSelect = page.getByLabel('Assembly Constituency');
    await page.waitForFunction(
      (districtCode) => {
        const labels = Array.from(document.querySelectorAll('label'));
        const acLabel = labels.find(l => l.innerText?.toLowerCase().includes('assembly constituency'));
        const select = acLabel ? document.getElementById(acLabel.htmlFor) || acLabel.querySelector('select') : null;
        if (!select) return false;
        // Check if options are loaded and not just the placeholder
        const validOptions = Array.from(select.options).filter(
          o => o.value && o.value !== '' && o.value !== '0' && !o.text.toLowerCase().includes('select')
        );
        return validOptions.length > 0;
      },
      dist.districtCode,
      { timeout: 15000 }
    ).catch(() => {});

    // Brief stabilization pause
    await page.waitForTimeout(400);

    // Extract AC options
    const acElements = await acSelect.locator('option').all();
    const constituencyList = [];
    for (const opt of acElements) {
      const val = (await opt.getAttribute('value'))?.trim();
      const txt = (await opt.textContent())?.trim();
      if (val && val !== '' && val !== '0' && !txt?.toLowerCase().includes('select')) {
        const parsed = parseConstituencyLabel(txt, val);
        constituencyList.push(parsed);
      }
    }

    resultData.districts.push({
      districtCode: dist.districtCode,
      districtName: dist.districtName,
      totalConstituencies: constituencyList.length,
      constituencies: constituencyList
    });

    resultData.totalConstituencies += constituencyList.length;
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write JSON data to disk
  const formattedJson = JSON.stringify(resultData, null, 2);
  fs.writeFileSync(OUTPUT_FILE, formattedJson, 'utf-8');
  fs.writeFileSync(DEFAULT_JSON_FILE, formattedJson, 'utf-8');

  // Print JSON only to console / stdout
  console.log(formattedJson);

  // Assertion to verify extraction succeeded
  expect(resultData.totalDistricts).toBeGreaterThan(0);
  expect(resultData.totalConstituencies).toBeGreaterThan(0);
});
