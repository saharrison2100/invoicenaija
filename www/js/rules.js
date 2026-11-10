/**
 * InvoiceNaija business rules.
 *
 * Deliberately free of DOM and storage so every number and every decision can be unit tested in
 * Node. Money is integer kobo throughout: floating point money is how invoices end up a kobo wrong.
 *
 * V2 adds partial payments, balances, receipts, reminder scheduling, recurring dates and plan limits.
 */

import { format as formatMoney } from './money.js';

export const VAT_RATE_BPS = 750; // 7.5% in basis points
export const VAT_PERCENT = '7.5%';

export const STATUS = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIAL: 'Partially Paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
};

export const STORED_STATUS = [STATUS.DRAFT, STATUS.SENT, STATUS.PAID];
export const PAYMENT_METHODS = ['Cash', 'Transfer', 'POS', 'Other'];

export const FREE_INVOICE_LIMIT = 3;
export const PRICES = {
  pro_monthly: 250000, // ₦2,500
  pro_yearly: 2000000, // ₦20,000
  per_invoice: 20000, // ₦200
};

/** Rounds half up in integer kobo: 7.5% of ₦1 is 8 kobo, never 7.4999. */
export function vatOnKobo(taxableKobo) {
  return Math.floor((taxableKobo * VAT_RATE_BPS + 5000) / 10000);
}

/** Subtotal -> discount -> taxable -> VAT -> total. Discount can never exceed the subtotal. */
export function totals(items = [], discountKobo = 0, vatEnabled = false) {
  const subtotal = items.reduce((sum, item) => {
    const qty = Math.max(0, Number(item.qty) || 0);
    const price = Math.max(0, Number(item.unit_price) || 0);
    return sum + Math.round(qty * price);
  }, 0);
  const discount = Math.min(Math.max(0, Math.round(discountKobo) || 0), subtotal);
  const taxable = subtotal - discount;
  const vat = vatEnabled ? vatOnKobo(taxable) : 0;
  return { subtotal, discount, taxable, vat, total: taxable + vat };
}

export function invoiceTotals(invoice) {
  return totals(invoice?.items || [], invoice?.discount_kobo || 0, Boolean(invoice?.vat_enabled));
}

export function invoiceTotal(invoice) {
  return invoiceTotals(invoice).total;
}

// ---- partial payments -------------------------------------------------------------------

/** Everything paid against one invoice, in kobo. */
export function paidKobo(invoiceId, payments = []) {
  return payments
    .filter((payment) => payment.invoice_id === invoiceId)
    .reduce((sum, payment) => sum + Math.max(0, Math.round(payment.amount_kobo || 0)), 0);
}

/**
 * Cash actually collected, capped at the invoice total.
 * An invoice explicitly marked Paid (legacy or manually) counts as settled even if its payment
 * rows were never written; a part-paid invoice counts exactly what was received.
 */
export function collectedOn(invoice, payments = []) {
  const total = invoiceTotal(invoice);
  if (invoice?.status === STATUS.PAID) return total;
  return Math.min(total, paidKobo(invoice.id, payments));
}

/** What is still owed: never negative, never more than the total. */
export function balanceDue(invoice, payments = []) {
  return Math.max(0, invoiceTotal(invoice) - collectedOn(invoice, payments));
}

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ms) {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * The status a person sees.
 * Paid and Draft are stored; Partially Paid and Overdue are worked out from payments and the date,
 * so they can never drift out of date.
 */
export function effectiveStatus(invoice, payments = [], now = Date.now()) {
  const stored = invoice?.status || STATUS.DRAFT;
  const total = invoiceTotal(invoice);
  const collected = collectedOn(invoice, payments);

  if (stored === STATUS.PAID) return STATUS.PAID;
  if (stored === STATUS.DRAFT && collected === 0) return STATUS.DRAFT;
  if (collected >= total && total > 0) return STATUS.PAID;
  if (now > endOfDay(invoice.due_date) && collected < total) return STATUS.OVERDUE;
  if (collected > 0) return STATUS.PARTIAL;
  return STATUS.SENT;
}

export function isFullyPaid(invoice, payments = []) {
  return paidKobo(invoice.id, payments) >= invoiceTotal(invoice);
}

export function isOverdue(invoice, payments = [], now = Date.now()) {
  return effectiveStatus(invoice, payments, now) === STATUS.OVERDUE;
}

/** A payment bigger than the balance is refused, not silently trimmed. */
export function validatePayment(invoice, payments, amountKobo, dateMs) {
  const balance = balanceDue(invoice, payments);
  const amount = Math.round(Number(amountKobo) || 0);
  if (balance <= 0) return { ok: false, message: 'This invoice is already fully paid' };
  if (amount <= 0) return { ok: false, message: 'Enter the amount received' };
  if (amount > balance) {
    return { ok: false, message: `Amount cannot be more than the balance of ${formatMoney(balance)}` };
  }
  if (dateMs && startOfDay(dateMs) > startOfDay(Date.now())) {
    return { ok: false, message: 'Payment date cannot be in the future' };
  }
  return { ok: true, amount, balanceAfter: balance - amount };
}

// ---- numbering --------------------------------------------------------------------------

function nextInSequence(prefix, existing, pad, separator = '-') {
  const clean = String(prefix || '').trim() || 'INV';
  const pattern = new RegExp(`^${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${separator}(\\d+)$`);
  let highest = 0;
  for (const number of existing) {
    const match = pattern.exec(String(number || ''));
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10) || 0);
  }
  return `${clean}${separator}${String(highest + 1).padStart(pad, '0')}`;
}

/** INV-001, INV-002 ... continuing from the highest number already used with that prefix. */
export function nextNumber(prefix, existingNumbers = []) {
  return nextInSequence(prefix || 'INV', existingNumbers, 3);
}

/** REC-001, REC-002 ... per business. */
export function nextReceiptNumber(existingNumbers = []) {
  return nextInSequence('REC', existingNumbers, 3);
}

// ---- validation -------------------------------------------------------------------------

/**
 * Nigerian mobile numbers: 0803..., 0705..., 0902... (11 digits) or +234/234 plus 10 digits.
 * Returns the international digits, which is what wa.me needs.
 */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { ok: false, e164: '', message: 'Enter a phone number' };
  if (digits.startsWith('234') && digits.length === 13) return { ok: true, e164: digits };
  if (digits.startsWith('0') && digits.length === 11) {
    const prefix = digits.slice(0, 3);
    if (['070', '080', '081', '090', '091', '071'].includes(prefix)) {
      return { ok: true, e164: '234' + digits.slice(1) };
    }
    return { ok: false, e164: '', message: 'Use a Nigerian number such as 0803 123 4567' };
  }
  if (digits.length === 10 && /^[789]/.test(digits)) return { ok: true, e164: '234' + digits };
  return { ok: false, e164: '', message: 'Use 0803 123 4567 or +234 803 123 4567' };
}

/** NUBAN account numbers are exactly 10 digits. */
export function normalizeAccountNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { ok: false, value: '', message: 'Enter your account number' };
  if (digits.length !== 10) return { ok: false, value: digits, message: 'Account number must be 10 digits' };
  return { ok: true, value: digits };
}

export function isValidPin(pin) {
  return /^\d{4,6}$/.test(String(pin || ''));
}

// ---- dates ------------------------------------------------------------------------------

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const LONG_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'short' });

export function shortDate(ms) {
  return ms ? DATE_FMT.format(new Date(ms)) : '';
}

export function longDate(ms) {
  return ms ? LONG_FMT.format(new Date(ms)) : '';
}

export function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function relativeDue(dueMs, now = Date.now()) {
  if (!dueMs) return 'No due date';
  const days = Math.round((startOfDay(dueMs) - startOfDay(now)) / 86400000);
  if (days > 1) return `Due in ${days} days`;
  if (days === 1) return 'Due tomorrow';
  if (days === 0) return 'Due today';
  if (days === -1) return '1 day overdue';
  return `${-days} days overdue`;
}

export const FREQUENCIES = ['Weekly', 'Monthly', 'Quarterly', 'Yearly'];

/** The next run date for a recurring invoice, keeping the day of the month where possible. */
export function advanceDate(ms, frequency) {
  const d = new Date(ms);
  const day = d.getDate();
  if (frequency === 'Weekly') d.setDate(day + 7);
  else if (frequency === 'Monthly') d.setMonth(d.getMonth() + 1, 1), d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  else if (frequency === 'Quarterly') d.setMonth(d.getMonth() + 3, 1), d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  else d.setFullYear(d.getFullYear() + 1, d.getMonth(), Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return d.getTime();
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// ---- reminders --------------------------------------------------------------------------

export const REMINDER_OFFSETS = [
  { key: 'before_3', label: '3 days before due', days: -3 },
  { key: 'on_due', label: 'On the due date', days: 0 },
  { key: 'after_3', label: '3 days after due', days: 3 },
  { key: 'after_7', label: '7 days after due', days: 7 },
  { key: 'after_14', label: '14 days after due', days: 14 },
];

export const DEFAULT_SCHEDULE = { before_3: true, on_due: true, after_3: true, after_7: true, after_14: false };

export const DEFAULT_REMINDER_TEMPLATE =
  'Good day {client_name}, hope you are doing well. This is a gentle reminder that invoice {invoice_number} ' +
  'for {amount_due} is {due_date}.\n\n' +
  'Kindly settle it when you can, and send me the payment details. If you have already paid, please ignore this message.\n\n' +
  'Thank you.\n{business_name}';

/** Which invoices need a nudge today, and why. Used by the follow-up list and notifications. */
export function dueReminders(invoices, payments, schedule = DEFAULT_SCHEDULE, now = Date.now(), reminderLog = []) {
  const today = startOfDay(now);
  const results = [];
  for (const invoice of invoices) {
    const status = effectiveStatus(invoice, payments, now);
    if (status === STATUS.PAID || status === STATUS.DRAFT) continue;
    const due = startOfDay(invoice.due_date);
    const delta = Math.round((due - today) / 86400000); // negative = overdue
    const matched = REMINDER_OFFSETS.filter((offset) => {
      if (!schedule?.[offset.key]) return false;
      if (offset.days === 0) return delta === 0;
      if (offset.days < 0) return delta === -offset.days; // before_3 (-3) => due in 3 days
      return -delta === offset.days; // days after due
    });
    if (!matched.length) continue;
    const alreadySentToday = reminderLog.some(
      (log) => log.invoice_id === invoice.id && startOfDay(log.sent_at) === today
    );
    results.push({
      invoice,
      status,
      balance: balanceDue(invoice, payments),
      reason: matched[0].label,
      urgency: delta < 0 ? 'overdue' : delta === 0 ? 'due' : 'soon',
      alreadySentToday,
    });
  }
  return results;
}

/** Fills the reminder placeholders, in a friendly Nigerian-English tone. */
export function reminderMessage(template, { business, client, invoice, balance, payLink } = {}) {
  const owed = balance ?? invoiceTotal(invoice);
  return String(template || DEFAULT_REMINDER_TEMPLATE)
    .replaceAll('{client_name}', client?.name || 'there')
    .replaceAll('{invoice_number}', invoice?.number || '')
    .replaceAll('{amount_due}', formatMoney(owed))
    .replaceAll('{due_date}', invoice?.due_date ? relativeDue(invoice.due_date).toLowerCase() : 'due')
    .replaceAll('{business_name}', business?.business_name || '')
    .replaceAll('{pay_link}', payLink || '');
}

/** The prefilled WhatsApp message sent with an invoice PDF. */
export function invoiceMessage(business, client, invoice, payments = []) {
  const total = invoiceTotal(invoice);
  const balance = balanceDue(invoice, payments);
  const lines = [`Hello ${client?.name || 'there'},`, ''];
  lines.push(
    `Please find invoice ${invoice.number} from ${business?.business_name || 'us'} for ${formatMoney(total)}` +
      `${invoice.due_date ? `, due ${shortDate(invoice.due_date)}` : ''}.`
  );
  if (balance > 0 && balance < total) lines.push(`Balance outstanding: ${formatMoney(balance)}.`);
  if (business?.bank_name || business?.account_number) {
    lines.push('', 'Payment details:');
    if (business.bank_name) lines.push(`Bank: ${business.bank_name}`);
    if (business.account_number) lines.push(`Account: ${business.account_number}`);
    if (business.account_name) lines.push(`Name: ${business.account_name}`);
  }
  lines.push('', 'Thank you.');
  if (business?.business_name) lines.push(business.business_name + (business.phone ? ` • ${business.phone}` : ''));
  return lines.join('\n');
}

export function waLink(phone, text) {
  const { ok, e164 } = normalizePhone(phone);
  const target = ok ? e164 : String(phone || '').replace(/\D/g, '');
  if (!target) return '';
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}

// ---- dashboard statistics ---------------------------------------------------------------

export function computeStats(invoices, payments = [], now = Date.now()) {
  let invoiced = 0;
  let paid = 0;
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let partialCount = 0;
  let collectedThisMonth = 0;
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  for (const invoice of invoices) {
    if (invoice.status === STATUS.DRAFT && paidKobo(invoice.id, payments) === 0) continue;
    const { total } = invoiceTotals(invoice);
    const collected = collectedOn(invoice, payments);
    const balance = total - collected;
    invoiced += total;
    paid += collected;
    outstanding += balance;
    if (collected > 0 && balance > 0) partialCount += 1;
    if (isOverdue(invoice, payments, now) && balance > 0) {
      overdueAmount += balance;
      overdueCount += 1;
    }
  }

  for (const payment of payments) {
    if (payment.payment_date >= monthStart.getTime() && payment.payment_date <= now) {
      collectedThisMonth += Math.round(payment.amount_kobo || 0);
    }
  }

  return {
    invoiced,
    paid,
    outstanding,
    overdueAmount,
    overdueCount,
    partialCount,
    collectedThisMonth,
    count: invoices.filter((invoice) => invoice.status !== STATUS.DRAFT).length,
  };
}

/** Collections per month for the last six months, oldest first, for the dashboard chart. */
export function collectionsByMonth(invoices, payments = [], now = Date.now()) {
  const buckets = [];
  const base = new Date(now);
  base.setDate(1);
  base.setHours(0, 0, 0, 0);
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(base);
    d.setMonth(d.getMonth() - i);
    const start = d.getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const amount = payments
      .filter((payment) => payment.payment_date >= start && payment.payment_date < end)
      .reduce((sum, payment) => sum + Math.max(0, Math.round(payment.amount_kobo || 0)), 0);
    buckets.push({ label: MONTH_FMT.format(d), amount, start, end });
  }
  return buckets;
}

export function owedByClient(invoices, payments, clientId, now = Date.now()) {
  return invoices
    .filter(
      (invoice) =>
        invoice.client_id === clientId &&
        effectiveStatus(invoice, payments, now) !== STATUS.PAID &&
        invoice.status !== STATUS.DRAFT
    )
    .reduce((sum, invoice) => sum + balanceDue(invoice, payments), 0);
}

// ---- plans and limits -------------------------------------------------------------------

/** Invoices created by the business this calendar month, sample data excluded. */
export function monthlyInvoiceCount(invoices, now = Date.now()) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return invoices.filter(
    (invoice) => !invoice.is_sample && invoice.issue_date >= start && invoice.issue_date < end
  ).length;
}

export function isPro(plan) {
  if (!plan) return false;
  if (plan.tier !== 'Pro') return false;
  if (!plan.renews_at) return true;
  return plan.renews_at > Date.now();
}

/** Free plan: 3 invoices a month. Viewing and paying existing invoices is never blocked. */
export function canCreateInvoice(data, now = Date.now()) {
  if (isPro(data.plan)) return { allowed: true, used: monthlyInvoiceCount(data.invoices, now), limit: null };
  const used = monthlyInvoiceCount(data.invoices, now);
  return { allowed: used < FREE_INVOICE_LIMIT, used, limit: FREE_INVOICE_LIMIT };
}

/** Does this invoice get the logo and custom colours in its PDF? */
export function canBrandPdf(data, invoice) {
  return isPro(data.plan) || Boolean(invoice?.pdf_unlocked);
}
