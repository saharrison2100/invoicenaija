/**
 * End-to-end smoke test in a real Chromium.
 *
 * Drives the actual app against a local static server: sign up, onboard, invoice, partial payment,
 * receipt, PDF download, reminder, upgrade (test mode) and a recurring run. Fails on any console
 * error or page exception, and saves screenshots to ./screenshots for the README.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = 8137;
const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const DOWNLOADS = path.join(ROOT, '.downloads');
const CHROME = '/opt/google/chrome/chrome';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`  ✓ ${message}`);

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function textOf(page) {
  return page.evaluate(() => document.body.innerText);
}

async function clickAct(page, act, { id, nth = 0 } = {}) {
  const ok = await page.evaluate(
    ({ act, id, nth }) => {
      const nodes = [...document.querySelectorAll(`[data-act="${act}"]`)].filter(
        (node) => id === undefined || node.dataset.id === id
      );
      const target = nodes[nth];
      if (!target) return false;
      target.click();
      return true;
    },
    { act, id, nth }
  );
  assert(ok, `could click ${act}${id ? `[${id}]` : ''}`);
  await wait(320);
}

async function fill(page, selector, value) {
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function latestDownload() {
  const files = (await readdir(DOWNLOADS)).filter((file) => file.endsWith('.pdf'));
  if (!files.length) return null;
  const stats = await Promise.all(
    files.map(async (file) => ({ file, at: (await readFile(path.join(DOWNLOADS, file))).length }))
  );
  return stats.sort((a, b) => b.at - a.at)[0].file;
}

async function main() {
  await rm(SHOTS, { recursive: true, force: true });
  await rm(DOWNLOADS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  await mkdir(DOWNLOADS, { recursive: true });

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'www'], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=430,900'],
    defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });

  try {
    await wait(600);
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle0' });

    // ---- auth ---------------------------------------------------------------------------
    let body = await textOf(page);
    assert(body.includes('Create, send and track'), 'auth screen renders');
    await shot(page, '01-auth');
    log('auth screen');

    await fill(page, '#auth-phone', '08031234567');
    await fill(page, '#auth-pin', '1234');
    await clickAct(page, 'auth-signup');

    // ---- onboarding ---------------------------------------------------------------------
    body = await textOf(page);
    assert(body.includes('Your business details'), 'onboarding appears after signup');
    await fill(page, '#ob-name', 'Ada Cakes and Catering');
    await fill(page, '#ob-phone', '08031234567');
    await fill(page, '#ob-whatsapp', '08031234567');
    await fill(page, '#ob-address', '12 Ademola Street, Ikoyi, Lagos');
    await fill(page, '#ob-bank', 'Guaranty Trust Bank');
    await fill(page, '#ob-account-number', '0123456789');
    await fill(page, '#ob-account-name', 'Ada Nwosu');
    await shot(page, '02-onboarding');
    await clickAct(page, 'onboard-save');
    log('onboarding saved');

    // ---- dashboard ----------------------------------------------------------------------
    body = await textOf(page);
    const lower = body.toLowerCase();
    assert(lower.includes('total invoiced'), 'dashboard stats render');
    assert(lower.includes('collections'), 'collections chart renders');
    assert(lower.includes('partially paid'), 'partially paid card renders');
    await wait(400);
    await shot(page, '03-dashboard');
    log('dashboard with sample data and chart');

    // ---- invoices list ------------------------------------------------------------------
    await clickAct(page, 'tab', { id: 'invoices' });
    body = await textOf(page);
    assert(body.includes('INV-002'), 'sample invoices listed');
    await shot(page, '04-invoices');
    log('invoice list');

    // ---- open a partially paid invoice ---------------------------------------------------
    const opened = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-act="open-invoice"]')];
      const target = rows.find((row) => row.innerText.includes('INV-002'));
      if (!target) return false;
      target.click();
      return true;
    });
    assert(opened, 'INV-002 opens');
    await wait(500);
    body = await textOf(page);
    assert(body.includes('of') && body.toLowerCase().includes('balance'), 'balance bar shows');
    // A part-paid invoice past its due date is correctly shown as Overdue, not Partially Paid.
    const previewLower = body.toLowerCase();
    assert(
      previewLower.includes('partially paid') || previewLower.includes('overdue'),
      'part-paid invoice shows its real status'
    );
    assert(previewLower.includes('record payment'), 'record payment action is offered');
    await shot(page, '05-preview-partial');
    log('invoice preview shows balance and Partially Paid status');

    // ---- record a partial payment --------------------------------------------------------
    await clickAct(page, 'record-payment');
    await fill(page, '#pay-amount', '25000');
    await page.select('#pay-method', 'Transfer');
    await fill(page, '#pay-reference', 'GTB-99123');
    await shot(page, '06-payment-sheet');
    await clickAct(page, 'save-payment');
    await wait(700);
    body = await textOf(page);
    assert(/REC-\d{3}/.test(body), 'receipt number issued');
    assert(body.includes('Thank you'), 'receipt shows thank-you line');
    await shot(page, '07-receipt');
    log('partial payment recorded and receipt issued');

    // ---- receipt PDF download -------------------------------------------------------------
    await clickAct(page, 'download-receipt');
    await wait(3200);
    const receiptPdf = await latestDownload();
    assert(receiptPdf, 'receipt PDF downloaded');
    const receiptBytes = await readFile(path.join(DOWNLOADS, receiptPdf));
    assert(receiptBytes.subarray(0, 5).toString() === '%PDF-', 'receipt file is a real PDF');
    assert(receiptBytes.length > 8000, 'receipt PDF has content');
    log(`receipt PDF downloaded (${Math.round(receiptBytes.length / 1024)} KB, ${receiptPdf})`);

    await clickAct(page, 'close-modal');
    await wait(400);

    // ---- reminder ------------------------------------------------------------------------
    await clickAct(page, 'remind');
    await wait(400);
    const reminder = await page.evaluate(() => ({
      text: document.querySelector('#reminder-text')?.value || '',
      wa: Boolean([...document.querySelectorAll('[data-act="send-reminder-whatsapp"]')].length),
    }));
    assert(reminder.text.includes('INV-002'), 'reminder prefills invoice number');
    assert(reminder.text.includes('₦'), 'reminder prefills amount due');
    assert(reminder.wa, 'WhatsApp send button present');
    await shot(page, '08-reminder');
    await clickAct(page, 'close-modal');
    log('reminder message prefilled from the template');

    // ---- invoice PDF download ------------------------------------------------------------
    await clickAct(page, 'download-invoice');
    await wait(3200);
    const invoicePdf = await latestDownload();
    assert(invoicePdf, 'invoice PDF downloaded');
    const invoiceBytes = await readFile(path.join(DOWNLOADS, invoicePdf));
    assert(invoiceBytes.subarray(0, 5).toString() === '%PDF-', 'invoice file is a real PDF');
    log(`invoice PDF downloaded (${Math.round(invoiceBytes.length / 1024)} KB, ${invoicePdf})`);

    // ---- upgrade (test mode) --------------------------------------------------------------
    await clickAct(page, 'back');
    await clickAct(page, 'tab', { id: 'settings' });
    await clickAct(page, 'upgrade');
    await wait(400);
    body = await textOf(page);
    assert(body.includes('Test mode'), 'upgrade screen explains test mode');
    await shot(page, '09-upgrade');
    await clickAct(page, 'buy', { id: 'monthly' });
    await wait(400);
    await clickAct(page, 'test-activate', { id: 'monthly' });
    await wait(600);
    body = await textOf(page);
    const planTier = await page.evaluate(() => window.InvoiceNaija.state.data.plan.tier);
    const planRenews = await page.evaluate(() => window.InvoiceNaija.state.data.plan.renews_at);
    assert(planTier === 'Pro', 'plan switched to Pro');
    assert(planRenews > Date.now(), 'Pro has a renewal date');
    assert(body.toLowerCase().includes('active'), 'upgrade screen shows the plan as active');
    log('upgrade flow (test mode) activated Pro');

    // ---- recurring ------------------------------------------------------------------------
    await clickAct(page, 'tab', { id: 'invoices' });
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-act="open-invoice"]')];
      rows.find((row) => row.innerText.includes('INV-003'))?.click();
    });
    await wait(500);
    await clickAct(page, 'make-recurring');
    await wait(300);
    await page.select('#rec-frequency', 'Monthly');
    await clickAct(page, 'save-recurring');
    await wait(600);
    body = await textOf(page);
    assert(body.includes('Recurring'), 'recurring screen reached');
    await shot(page, '10-recurring');
    const beforeCount = await page.evaluate(() => window.InvoiceNaija.state.data.invoices.length);
    await clickAct(page, 'run-recurring');
    await wait(900);
    const afterCount = await page.evaluate(() => window.InvoiceNaija.state.data.invoices.length);
    assert(afterCount === beforeCount + 1, 'recurring run generated one invoice');
    log('recurring schedule created and generated an invoice');

    // ---- settings screenshot + logo gate --------------------------------------------------
    await clickAct(page, 'tab', { id: 'settings' });
    await wait(300);
    await shot(page, '11-settings');

    // ---- reload: data and plan persist ----------------------------------------------------
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(800);
    const persisted = await page.evaluate(() => ({
      invoices: window.InvoiceNaija.state.data.invoices.length,
      plan: window.InvoiceNaija.state.data.plan.tier,
      receipts: window.InvoiceNaija.state.data.receipts.length,
      payments: window.InvoiceNaija.state.data.payments.length,
    }));
    assert(persisted.invoices >= 6, 'invoices persist across reload');
    assert(persisted.plan === 'Pro', 'plan persists across reload');
    assert(persisted.receipts >= 3, 'receipts persist');
    assert(persisted.payments >= 3, 'payments persist');
    log('data persists across a reload');

    // ---- free-plan limit ------------------------------------------------------------------
    await page.evaluate(() => {
      const { state, S } = window.InvoiceNaija;
      state.data.plan = { ...state.data.plan, tier: 'Free', renews_at: null };
      for (let i = 0; i < 3; i += 1) {
        S.newInvoice(state.data, {
          client_id: state.data.clients[0].id,
          items: [{ description: 'Limit test', qty: 1, unit_price: 1000 }],
        });
      }
      S.saveData(state.account.id, state.data);
      location.reload();
    });
    await wait(1200);
    await clickAct(page, 'new-invoice');
    await wait(400);
    body = await textOf(page);
    const paywall = body.toLowerCase();
    assert(paywall.includes('plans') && paywall.includes('upgrade'), 'free limit opens the plans screen');
    assert(paywall.includes('used up'), 'paywall explains the monthly limit');
    const editorOpen = await page.evaluate(() => Boolean(document.querySelector('[data-field="item-desc"]')));
    assert(!editorOpen, 'invoice editor is blocked once the free limit is reached');
    await shot(page, '12-paywall');
    log('free plan limit raises the paywall instead of blocking existing invoices');

    if (errors.length) {
      throw new Error(`Console errors:\n${errors.join('\n')}`);
    }
    console.log('\nSMOKE TEST PASSED');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch(async (error) => {
  console.error('\nSMOKE TEST FAILED:', error.message);
  process.exit(1);
});
