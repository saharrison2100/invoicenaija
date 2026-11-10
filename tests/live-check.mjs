/** Verifies the deployed GitHub Pages app really works (not just that the HTML is served). */
import puppeteer from 'puppeteer-core';

const URL = 'https://saharrison2100.github.io/invoicenaija/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const browser = await puppeteer.launch({
  executablePath: '/opt/google/chrome/chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(1200);
  let body = await page.evaluate(() => document.body.innerText);
  assert(body.includes('Create, send and track'), 'live site shows the sign-in screen');
  assert(page.url().includes('/invoicenaija/www/'), 'root redirects to the app');

  await page.type('#auth-phone', '08123456789');
  await page.type('#auth-pin', '4321');
  await page.evaluate(() => document.querySelector('[data-act="auth-signup"]').click());
  await wait(600);
  await page.type('#ob-name', 'Live Check Tailoring');
  await page.type('#ob-account-number', '0123456789');
  await page.evaluate(() => document.querySelector('[data-act="onboard-save"]').click());
  await wait(1000);
  body = await page.evaluate(() => document.body.innerText);
  assert(body.toLowerCase().includes('total invoiced'), 'dashboard renders on the live site');
  assert(/INV-0\d\d/.test(body), 'sample invoices seed on the live site');
  await page.evaluate(() => document.querySelector('[data-act="tab"][data-id="invoices"]').click());
  await wait(700);
  const listText = await page.evaluate(() => document.body.innerText);
  const listed = (listText.match(/INV-0\d\d/g) || []).length;
  assert(listed >= 5, `all five sample invoices are listed (found ${listed})`);

  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'none';
  });
  assert(sw === 'registered', `service worker should register for offline use (got ${sw})`);

  await page.screenshot({ path: 'screenshots/13-live-pages.png' });
  console.log('LIVE CHECK PASSED');
  console.log('  sign-in, onboarding, dashboard, sample data and service worker all work on Pages');
  if (errors.length) console.log('  console errors (non-fatal):', errors.slice(0, 3));
} finally {
  await browser.close();
}
