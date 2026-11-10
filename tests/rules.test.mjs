/**
 * Unit tests for the money and invoice rules. Run with: npm test
 * These cover both V1 behaviour and the V2 additions (partial payments, receipts, reminders,
 * recurring dates, plan limits) because every one of them is money or access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseToKobo, plain, format, compact } from '../www/js/money.js';
import {
  STATUS,
  totals,
  invoiceTotal,
  balanceDue,
  paidKobo,
  effectiveStatus,
  validatePayment,
  nextNumber,
  nextReceiptNumber,
  advanceDate,
  normalizePhone,
  normalizeAccountNumber,
  reminderMessage,
  dueReminders,
  DEFAULT_SCHEDULE,
  monthlyInvoiceCount,
  canCreateInvoice,
  canBrandPdf,
  computeStats,
  collectionsByMonth,
  isPro,
  FREQUENCIES,
} from '../www/js/rules.js';

const DAY = 86400000;
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();
const TODAY = at(2026, 11, 10);

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    number: 'INV-001',
    issue_date: TODAY - 10 * DAY,
    due_date: TODAY + 4 * DAY,
    items: [{ id: 'i1', description: 'Suit', qty: 2, unit_price: 5000000 }], // ₦50,000 each
    discount_kobo: 0,
    vat_enabled: false,
    status: STATUS.SENT,
    ...overrides,
  };
}

function payment(amountNaira, overrides = {}) {
  return {
    id: `pay-${Math.random().toString(16).slice(2)}`,
    invoice_id: 'inv-1',
    amount_kobo: amountNaira * 100,
    payment_date: TODAY,
    method: 'Transfer',
    ...overrides,
  };
}

// ---- money ------------------------------------------------------------------------------

test('parses naira the way people type it', () => {
  assert.equal(parseToKobo('1500'), 150000);
  assert.equal(parseToKobo('1,500.50'), 150050);
  assert.equal(parseToKobo('₦ 2,500'), 250000);
  assert.equal(parseToKobo('0.05'), 5);
  assert.equal(parseToKobo(''), 0);
  assert.equal(parseToKobo(null), 0);
  assert.equal(parseToKobo('abc'), 0);
  assert.equal(parseToKobo('1.500,75'), 150075);
});

test('formats money as ₦1,234.00 everywhere', () => {
  assert.equal(format(150050), '₦1,500.50');
  assert.equal(format(1500000), '₦15,000.00');
  assert.equal(format(0), '₦0.00');
  assert.equal(format(-150000), '-₦1,500.00');
  assert.equal(compact(1500000), '₦15,000');
  assert.equal(plain(125000000), '1,250,000.00');
});

// ---- totals -----------------------------------------------------------------------------

test('subtotal, discount, VAT and total add up', () => {
  const t = totals([{ qty: 2, unit_price: 100000 }, { qty: 1, unit_price: 50000 }], 10000, true);
  assert.equal(t.subtotal, 250000);
  assert.equal(t.discount, 10000);
  assert.equal(t.taxable, 240000);
  assert.equal(t.vat, 18000); // 7.5% of 240000
  assert.equal(t.total, 258000);
});

test('VAT rounds to the nearest kobo', () => {
  assert.equal(totals([{ qty: 1, unit_price: 100 }], 0, true).vat, 8);
  assert.equal(totals([{ qty: 1, unit_price: 200 }], 0, true).vat, 15);
});

test('discount cannot exceed the subtotal and negatives are ignored', () => {
  const t = totals([{ qty: 1, unit_price: 5000 }], 900000, true);
  assert.equal(t.discount, 5000);
  assert.equal(t.total, 0);
  assert.equal(totals([{ qty: -3, unit_price: 1000 }], 0, false).subtotal, 0);
});

// ---- partial payments -------------------------------------------------------------------

test('payments reduce the balance and never go negative', () => {
  const inv = invoice();
  assert.equal(invoiceTotal(inv), 10000000); // ₦100,000
  assert.equal(balanceDue(inv, []), 10000000);
  assert.equal(balanceDue(inv, [payment(40000)]), 6000000);
  assert.equal(balanceDue(inv, [payment(40000), payment(60000)]), 0);
  assert.equal(balanceDue(inv, [payment(150000)]), 0); // overpayment never shows a credit
  assert.equal(paidKobo(inv.id, [payment(40000)]), 4000000);
});

test('status moves Sent -> Partially Paid -> Paid', () => {
  const inv = invoice();
  assert.equal(effectiveStatus(inv, [], TODAY), STATUS.SENT);
  assert.equal(effectiveStatus(inv, [payment(25000)], TODAY), STATUS.PARTIAL);
  assert.equal(effectiveStatus(inv, [payment(25000), payment(75000)], TODAY), STATUS.PAID);
});

test('an unpaid or part-paid invoice past its due date is Overdue', () => {
  const overdue = invoice({ due_date: TODAY - 2 * DAY });
  assert.equal(effectiveStatus(overdue, [], TODAY), STATUS.OVERDUE);
  assert.equal(effectiveStatus(overdue, [payment(10000)], TODAY), STATUS.OVERDUE);
  assert.equal(effectiveStatus(overdue, [payment(100000)], TODAY), STATUS.PAID);
  // On the due date itself it is not late yet.
  assert.equal(effectiveStatus(invoice({ due_date: TODAY }), [], at(2026, 11, 10, 23)), STATUS.SENT);
});

test('a draft with no payment stays a draft even when late', () => {
  const draft = invoice({ status: STATUS.DRAFT, due_date: TODAY - 30 * DAY });
  assert.equal(effectiveStatus(draft, [], TODAY), STATUS.DRAFT);
});

test('payments bigger than the balance, zero or future-dated are refused', () => {
  const inv = invoice();
  assert.equal(validatePayment(inv, [], 200000 * 100, TODAY).ok, false);
  assert.equal(validatePayment(inv, [], 0, TODAY).ok, false);
  assert.equal(validatePayment(inv, [], 100, TODAY + 2 * DAY).ok, false);
  assert.equal(validatePayment(inv, [], 25000 * 100, TODAY).ok, true);
  const full = validatePayment(inv, [payment(50000)], 50000 * 100, TODAY);
  assert.equal(full.ok, true);
  assert.equal(full.balanceAfter, 0);
  // Already settled: no further payment can be recorded.
  assert.equal(validatePayment(inv, [payment(100000)], 100, TODAY).ok, false);
});

// ---- numbering --------------------------------------------------------------------------

test('invoice and receipt numbers are sequential per business', () => {
  assert.equal(nextNumber('INV', []), 'INV-001');
  assert.equal(nextNumber('INV', ['INV-001', 'INV-002']), 'INV-003');
  assert.equal(nextNumber('INV', ['INV-001', 'INV-006']), 'INV-007');
  assert.equal(nextNumber('QBS', ['INV-009', 'QBS-001']), 'QBS-002');
  assert.equal(nextNumber('', []), 'INV-001');
  assert.equal(nextReceiptNumber([]), 'REC-001');
  assert.equal(nextReceiptNumber(['REC-001', 'REC-002']), 'REC-003');
});

// ---- recurring dates --------------------------------------------------------------------

test('recurring dates advance by the chosen frequency', () => {
  const jan31 = at(2026, 1, 31);
  assert.equal(new Date(advanceDate(at(2026, 3, 10), 'Weekly')).getDate(), 17);
  assert.equal(new Date(advanceDate(jan31, 'Monthly')).getMonth(), 1); // Feb
  assert.equal(new Date(advanceDate(jan31, 'Monthly')).getDate(), 28); // clamped, no 31 Feb
  assert.equal(new Date(advanceDate(at(2026, 11, 10), 'Quarterly')).getMonth(), 1); // Feb 2027
  assert.equal(new Date(advanceDate(at(2026, 11, 10), 'Yearly')).getFullYear(), 2027);
  assert.deepEqual(FREQUENCIES, ['Weekly', 'Monthly', 'Quarterly', 'Yearly']);
});

// ---- reminders --------------------------------------------------------------------------

test('reminder schedule picks the right invoices', () => {
  const soon = invoice({ id: 'a', number: 'INV-001', due_date: TODAY + 3 * DAY });
  const dueToday = invoice({ id: 'b', number: 'INV-002', due_date: TODAY });
  const late7 = invoice({ id: 'c', number: 'INV-003', due_date: TODAY - 7 * DAY });
  const late14 = invoice({ id: 'd', number: 'INV-004', due_date: TODAY - 14 * DAY });
  const quiet = invoice({ id: 'e', number: 'INV-005', due_date: TODAY + 20 * DAY });
  const paid = invoice({ id: 'f', number: 'INV-006', due_date: TODAY - 3 * DAY, status: STATUS.PAID });

  const found = dueReminders([soon, dueToday, late7, late14, quiet, paid], [], DEFAULT_SCHEDULE, TODAY);
  const ids = found.map((entry) => entry.invoice.id).sort();
  // before_3 catches the one due in 3 days, on_due catches today's, after_7 the 7-day-late one.
  // Nothing fires for the 14-day-late invoice (that step is off) or the one due in 20 days.
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(found.find((entry) => entry.invoice.id === 'c').urgency, 'overdue');
});

test('turning a schedule step off stops that reminder', () => {
  const late7 = invoice({ due_date: TODAY - 7 * DAY });
  const schedule = { ...DEFAULT_SCHEDULE, after_7: false };
  assert.equal(dueReminders([late7], [], schedule, TODAY).length, 0);
});

test('reminder message fills every placeholder and never leaks braces', () => {
  const inv = invoice({ due_date: TODAY + 2 * DAY, number: 'INV-007' });
  const text = reminderMessage(
    '{client_name}|{invoice_number}|{amount_due}|{due_date}|{business_name}|{pay_link}',
    {
      business: { business_name: 'Ada Cakes' },
      client: { name: 'Tunde' },
      invoice: inv,
      balance: 6000000,
      payLink: 'https://pay.example/abc',
    }
  );
  assert.equal(text, 'Tunde|INV-007|₦60,000.00|due in 2 days|Ada Cakes|https://pay.example/abc');
  assert.ok(!text.includes('{'));
});

// ---- validation -------------------------------------------------------------------------

test('Nigerian phone numbers normalize to +234 for WhatsApp', () => {
  assert.deepEqual(normalizePhone('08031234567'), { ok: true, e164: '2348031234567' });
  assert.deepEqual(normalizePhone('+234 803 123 4567'), { ok: true, e164: '2348031234567' });
  assert.equal(normalizePhone('0803123456').ok, false); // 10 digits starting 0
  assert.equal(normalizePhone('12345').ok, false);
});

test('account numbers must be 10 digits', () => {
  assert.equal(normalizeAccountNumber('0123456789').ok, true);
  assert.equal(normalizeAccountNumber('012345678').ok, false);
  assert.equal(normalizeAccountNumber('').ok, false);
});

// ---- plans and limits -------------------------------------------------------------------

test('free plan allows 3 invoices a month, Pro is unlimited', () => {
  const data = { plan: { tier: 'Free' }, invoices: [] };
  for (let i = 0; i < 3; i += 1) {
    data.invoices.push(invoice({ id: `i${i}`, issue_date: TODAY - i * DAY }));
  }
  assert.equal(monthlyInvoiceCount(data.invoices, TODAY), 3);
  assert.equal(canCreateInvoice(data, TODAY).allowed, false);
  data.plan = { tier: 'Pro', renews_at: TODAY + 30 * DAY };
  assert.equal(canCreateInvoice(data, TODAY).allowed, true);
  // Last month's invoices do not count against this month.
  const old = { plan: { tier: 'Free' }, invoices: [invoice({ issue_date: at(2026, 10, 5) })] };
  assert.equal(monthlyInvoiceCount(old.invoices, TODAY), 0);
  assert.equal(canCreateInvoice(old, TODAY).allowed, true);
});

test('an expired Pro plan falls back to Free', () => {
  assert.equal(isPro({ tier: 'Pro', renews_at: TODAY - DAY }), false);
  assert.equal(isPro({ tier: 'Pro', renews_at: TODAY + DAY }), true);
  const data = {
    plan: { tier: 'Pro', renews_at: TODAY - DAY },
    invoices: [1, 2, 3, 4].map((n) => invoice({ id: `i${n}`, issue_date: TODAY })),
  };
  assert.equal(canCreateInvoice(data, TODAY).allowed, false);
});

test('PDF branding needs Pro or a per-invoice unlock', () => {
  assert.equal(canBrandPdf({ plan: { tier: 'Free' } }, { pdf_unlocked: false }), false);
  assert.equal(canBrandPdf({ plan: { tier: 'Free' } }, { pdf_unlocked: true }), true);
  assert.equal(canBrandPdf({ plan: { tier: 'Pro', renews_at: TODAY + DAY } }, {}), true);
});

// ---- dashboard --------------------------------------------------------------------------

test('dashboard totals use balances, not invoice totals', () => {
  const paidInv = invoice({ id: 'p' });
  const partial = invoice({ id: 'x', due_date: TODAY + 10 * DAY });
  const late = invoice({ id: 'l', due_date: TODAY - 5 * DAY });
  const draft = invoice({ id: 'd', status: STATUS.DRAFT });
  const payments = [
    payment(100000, { invoice_id: 'p', payment_date: TODAY - 40 * DAY }),
    payment(40000, { invoice_id: 'x', payment_date: TODAY }),
    payment(20000, { invoice_id: 'p', payment_date: TODAY - 40 * DAY }),
  ];
  const stats = computeStats([paidInv, partial, late, draft], payments, TODAY);
  assert.equal(stats.partialCount, 1);
  assert.equal(stats.outstanding, 6000000 + 10000000); // partial balance + untouched late invoice
  assert.equal(stats.overdueCount, 1);
  assert.equal(stats.overdueAmount, 10000000);
  assert.equal(stats.collectedThisMonth, 4000000);
});

test('six month collections chart buckets payments by month', () => {
  const buckets = collectionsByMonth([], [
    payment(1000, { payment_date: TODAY }),
    payment(2000, { payment_date: at(2026, 10, 15) }),
    payment(500, { payment_date: at(2026, 3, 15) }), // outside the window
  ], TODAY);
  assert.equal(buckets.length, 6);
  assert.equal(buckets.at(-1).label, 'Nov');
  assert.equal(buckets.at(-1).amount, 100000);
  assert.equal(buckets.at(-2).amount, 200000);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.amount, 0), 300000);
});
