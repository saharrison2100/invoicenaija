/**
 * Local data layer.
 *
 * InvoiceNaija works fully offline: accounts, business profile, clients, invoices, payments,
 * receipts, recurring schedules and plan state live in this browser (localStorage). Each account
 * gets its own bucket, so two people on one phone never see each other's invoices.
 *
 * Auth is a device account: phone number + PIN, salted and SHA-256 hashed. There is no server, so
 * the PIN protects the app on the device. docs/BUILD.md explains how to move this to a backend.
 */

import {
  DEFAULT_REMINDER_TEMPLATE,
  DEFAULT_SCHEDULE,
  STATUS,
  advanceDate,
  nextNumber,
  nextReceiptNumber,
  normalizePhone,
  invoiceTotal,
} from './rules.js';

const NS = 'invoicenaija:';
const ACCOUNTS_KEY = `${NS}accounts`;
const SESSION_KEY = `${NS}session`;
const SCHEMA_VERSION = 2;

const now = () => Date.now();
const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `id-${now()}-${Math.random().toString(16).slice(2)}`;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn('Could not read', key, error);
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return bytesToHex(digest);
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes.buffer);
}

// ---- accounts ---------------------------------------------------------------------------

export const auth = {
  accounts() {
    return read(ACCOUNTS_KEY, []);
  },

  current() {
    const session = read(SESSION_KEY, null);
    if (!session?.accountId) return null;
    return this.accounts().find((account) => account.id === session.accountId) || null;
  },

  async signUp(phone, pin) {
    const { ok, e164 } = normalizePhone(phone);
    if (!ok) throw new Error('Enter a valid Nigerian phone number, e.g. 0803 123 4567');
    if (!/^\d{4,6}$/.test(pin)) throw new Error('Your PIN must be 4 to 6 digits');
    const accounts = this.accounts();
    if (accounts.some((account) => account.phone === e164)) {
      throw new Error('That number already has an account. Sign in instead.');
    }
    const salt = randomSalt();
    const account = {
      id: uid(),
      phone: e164,
      provider: 'phone',
      salt,
      pin_hash: await hashPin(pin, salt),
      created_at: now(),
    };
    accounts.push(account);
    write(ACCOUNTS_KEY, accounts);
    write(SESSION_KEY, { accountId: account.id, at: now() });
    return account;
  },

  async signIn(phone, pin) {
    const { ok, e164 } = normalizePhone(phone);
    if (!ok) throw new Error('Enter a valid Nigerian phone number');
    const account = this.accounts().find((candidate) => candidate.phone === e164);
    if (!account) throw new Error('No account for that number yet. Create one first.');
    if ((await hashPin(pin, account.salt)) !== account.pin_hash) throw new Error('Wrong PIN. Try again.');
    write(SESSION_KEY, { accountId: account.id, at: now() });
    return account;
  },

  /** Google sign-in keys the account on the verified email instead of a phone number. */
  async signInWithGoogle(email, name) {
    if (!email) throw new Error('Google did not return an email address');
    const accounts = this.accounts();
    let account = accounts.find((candidate) => candidate.email === email);
    if (!account) {
      account = {
        id: uid(),
        phone: '',
        email,
        name: name || '',
        provider: 'google',
        salt: randomSalt(),
        pin_hash: '',
        created_at: now(),
      };
      accounts.push(account);
      write(ACCOUNTS_KEY, accounts);
    }
    write(SESSION_KEY, { accountId: account.id, at: now() });
    return account;
  },

  signOut() {
    localStorage.removeItem(SESSION_KEY);
  },
};

// ---- data -------------------------------------------------------------------------------

const dataKey = (accountId) => `${NS}data:${accountId}`;

export function emptyBusiness(accountId) {
  return {
    id: uid(),
    owner_id: accountId,
    business_name: '',
    phone: '',
    whatsapp: '',
    address: '',
    logo_url: '',
    bank_name: '',
    account_number: '',
    account_name: '',
    invoice_prefix: 'INV',
    vat_default: false,
    reminder_template: DEFAULT_REMINDER_TEMPLATE,
    reminder_schedule: { ...DEFAULT_SCHEDULE },
    brand_color: '',
    whatsapp_api_enabled: false,
  };
}

export function emptyPlan() {
  return { tier: 'Free', billing: 'Monthly', status: 'inactive', renews_at: null, last_reference: '', last_payment_at: null, receipts: [] };
}

export function emptyData(accountId) {
  return {
    version: SCHEMA_VERSION,
    business: emptyBusiness(accountId),
    clients: [],
    invoices: [],
    payments: [],
    receipts: [],
    recurring: [],
    reminder_log: [],
    notifications: [],
    plan: emptyPlan(),
    meta: { last_plan_check: 0, last_recurring_run: 0 },
  };
}

/** Brings older (V1) data up to the V2 shape without losing anything. */
export function migrate(data, accountId) {
  const base = emptyData(accountId);
  const merged = {
    ...base,
    ...data,
    business: { ...base.business, ...(data.business || {}) },
    plan: { ...base.plan, ...(data.plan || {}) },
    meta: { ...base.meta, ...(data.meta || {}) },
  };
  merged.clients = data.clients || [];
  merged.invoices = (data.invoices || []).map((invoice) => ({
    amount_paid: 0,
    balance_due: 0,
    recurring_id: null,
    pdf_unlocked: false,
    ...invoice,
  }));
  merged.payments = data.payments || [];
  merged.receipts = data.receipts || [];
  merged.recurring = data.recurring || [];
  merged.reminder_log = data.reminder_log || [];
  merged.notifications = data.notifications || [];

  // A V1 invoice marked Paid has no payment row. Give it one, so the ledger always explains the
  // status instead of the status pretending.
  for (const invoice of merged.invoices) {
    const total = invoiceTotal(invoice);
    const paid = merged.payments
      .filter((p) => p.invoice_id === invoice.id)
      .reduce((sum, p) => sum + p.amount_kobo, 0);
    if (invoice.status === STATUS.PAID && paid < total) {
      merged.payments.push({
        id: uid(),
        invoice_id: invoice.id,
        business_id: invoice.business_id,
        amount_kobo: total - paid,
        payment_date: invoice.paid_at || invoice.issue_date,
        method: 'Other',
        reference: '',
        note: 'Recorded as paid (migrated from V1)',
        created_at: now(),
      });
    }
  }
  // Keep the denormalised totals on the invoice in step with the payment ledger.
  for (const invoice of merged.invoices) {
    const total = invoiceTotal(invoice);
    const paid = merged.payments
      .filter((p) => p.invoice_id === invoice.id)
      .reduce((sum, p) => sum + p.amount_kobo, 0);
    invoice.amount_paid = Math.min(total, paid);
    invoice.balance_due = Math.max(0, total - Math.min(total, paid));
  }
  merged.version = SCHEMA_VERSION;
  return merged;
}

export function loadData(accountId) {
  return migrate(read(dataKey(accountId), {}), accountId);
}

export function saveData(accountId, data) {
  write(dataKey(accountId), data);
}

// ---- domain operations ------------------------------------------------------------------

export function newClient(data, fields) {
  const client = {
    id: uid(),
    business_id: data.business.id,
    name: String(fields.name || '').trim(),
    phone: String(fields.phone || '').trim(),
    email: String(fields.email || '').trim(),
    address: String(fields.address || '').trim(),
    created_at: now(),
    is_sample: Boolean(fields.is_sample),
  };
  data.clients.push(client);
  return client;
}

export function newInvoice(data, fields = {}) {
  const issue = fields.issue_date || now();
  const invoice = {
    id: uid(),
    business_id: data.business.id,
    client_id: fields.client_id || '',
    number: fields.number || nextNumber(data.business.invoice_prefix, data.invoices.map((i) => i.number)),
    issue_date: issue,
    due_date: fields.due_date || issue + 7 * 86400000,
    items: fields.items || [{ id: uid(), description: '', qty: 1, unit_price: 0 }],
    discount_kobo: fields.discount_kobo || 0,
    vat_enabled: fields.vat_enabled ?? data.business.vat_default,
    notes: fields.notes || '',
    status: fields.status || STATUS.SENT,
    paid_at: null,
    amount_paid: 0,
    balance_due: 0,
    recurring_id: fields.recurring_id || null,
    pdf_unlocked: false,
    is_sample: Boolean(fields.is_sample),
  };
  invoice.balance_due = invoiceTotal(invoice);
  data.invoices.unshift(invoice);
  return invoice;
}

export function duplicateInvoice(data, invoice) {
  const copy = JSON.parse(JSON.stringify(invoice));
  copy.id = uid();
  copy.number = nextNumber(data.business.invoice_prefix, data.invoices.map((i) => i.number));
  copy.issue_date = now();
  copy.due_date = now() + 7 * 86400000;
  copy.status = STATUS.SENT;
  copy.paid_at = null;
  copy.amount_paid = 0;
  copy.balance_due = invoiceTotal(copy);
  copy.pdf_unlocked = false;
  copy.is_sample = false;
  copy.recurring_id = null;
  copy.items = copy.items.map((item) => ({ ...item, id: uid() }));
  data.invoices.unshift(copy);
  return copy;
}

export function setStatus(data, invoiceId, status) {
  const invoice = data.invoices.find((candidate) => candidate.id === invoiceId);
  if (!invoice) return null;
  invoice.status = status;
  invoice.paid_at = status === STATUS.PAID ? now() : null;
  return invoice;
}

/**
 * Records a payment and issues its receipt in one step, so a payment can never exist without the
 * receipt the client was promised. The caller validates the amount first.
 */
export function recordPayment(data, invoice, { amount_kobo, payment_date, method, reference, note }) {
  const payment = {
    id: uid(),
    invoice_id: invoice.id,
    business_id: invoice.business_id,
    amount_kobo: Math.round(amount_kobo),
    payment_date: payment_date || now(),
    method: method || 'Cash',
    reference: String(reference || '').trim(),
    note: String(note || '').trim(),
    created_at: now(),
  };
  data.payments.push(payment);

  const total = invoiceTotal(invoice);
  const paid = data.payments
    .filter((p) => p.invoice_id === invoice.id)
    .reduce((sum, p) => sum + p.amount_kobo, 0);
  invoice.amount_paid = Math.min(total, paid);
  invoice.balance_due = Math.max(0, total - invoice.amount_paid);
  if (invoice.amount_paid >= total) {
    invoice.status = STATUS.PAID;
    invoice.paid_at = payment.payment_date;
  } else {
    invoice.status = STATUS.SENT;
    invoice.paid_at = null;
  }

  const receipt = {
    id: uid(),
    payment_id: payment.id,
    invoice_id: invoice.id,
    business_id: invoice.business_id,
    receipt_number: nextReceiptNumber(data.receipts.map((r) => r.receipt_number)),
    pdf_url: '',
    issued_at: now(),
  };
  data.receipts.push(receipt);
  renumberReceipts(data);
  return { payment, receipt };
}

function renumberReceipts(data) {
  // Receipt numbers are per business and always sequential in issue order.
  data.receipts
    .slice()
    .sort((a, b) => a.issued_at - b.issued_at)
    .forEach((receipt, index) => {
      receipt.receipt_number = `REC-${String(index + 1).padStart(3, '0')}`;
    });
}

export function receiptForPayment(data, paymentId) {
  return data.receipts.find((receipt) => receipt.payment_id === paymentId) || null;
}

export function receiptTotal(data, invoiceId) {
  return data.payments
    .filter((payment) => payment.invoice_id === invoiceId)
    .reduce((sum, payment) => sum + payment.amount_kobo, 0);
}

// ---- recurring --------------------------------------------------------------------------

export function makeRecurring(data, invoice, fields) {
  const recurring = {
    id: uid(),
    business_id: invoice.business_id,
    client_id: invoice.client_id,
    name: fields.name || `Invoice for ${data.clients.find((c) => c.id === invoice.client_id)?.name || 'client'}`,
    items: invoice.items.map((item) => ({ ...item, id: uid() })),
    discount_kobo: invoice.discount_kobo || 0,
    vat_enabled: Boolean(invoice.vat_enabled),
    notes: invoice.notes || '',
    frequency: fields.frequency || 'Monthly',
    next_run_date: fields.next_run_date || advanceDate(now(), fields.frequency || 'Monthly'),
    end_date: fields.end_date || null,
    auto_send: Boolean(fields.auto_send),
    active: true,
    created_at: now(),
    last_run_date: null,
    runs: 0,
  };
  data.recurring.push(recurring);
  invoice.recurring_id = recurring.id;
  return recurring;
}

/**
 * Runs every recurring invoice that is due (including ones missed while the app was closed) and
 * returns the invoices it created. Called on app start and from the Recurring screen.
 */
export function runDueRecurring(data, at = now()) {
  const created = [];
  for (const recurring of data.recurring) {
    if (!recurring.active) continue;
    let guard = 0;
    while (recurring.next_run_date <= at && guard < 24) {
      guard += 1;
      if (recurring.end_date && recurring.next_run_date > recurring.end_date) {
        recurring.active = false;
        break;
      }
      const client = data.clients.find((c) => c.id === recurring.client_id);
      const invoice = newInvoice(data, {
        client_id: recurring.client_id,
        issue_date: recurring.next_run_date,
        due_date: recurring.next_run_date + 7 * 86400000,
        items: recurring.items.map((item) => ({ ...item, id: uid() })),
        discount_kobo: recurring.discount_kobo,
        vat_enabled: recurring.vat_enabled,
        notes: recurring.notes,
        status: STATUS.SENT,
        recurring_id: recurring.id,
      });
      invoice.number = nextNumber(data.business.invoice_prefix, data.invoices.map((i) => i.number));
      created.push({ invoice, recurring, client });
      recurring.last_run_date = recurring.next_run_date;
      recurring.runs = (recurring.runs || 0) + 1;
      recurring.next_run_date = advanceDate(recurring.next_run_date, recurring.frequency);
      if (recurring.end_date && recurring.next_run_date > recurring.end_date) recurring.active = false;
    }
  }
  return created;
}

// ---- reminders and notifications --------------------------------------------------------

export function logReminder(data, invoiceId, channel, templateUsed) {
  const log = {
    id: uid(),
    invoice_id: invoiceId,
    channel,
    sent_at: now(),
    template_used: templateUsed,
  };
  data.reminder_log.push(log);
  return log;
}

export function notify(data, title, body) {
  const notification = { id: uid(), title, body, at: now(), read: false };
  data.notifications.unshift(notification);
  data.notifications = data.notifications.slice(0, 30);
  return notification;
}

// ---- plan -------------------------------------------------------------------------------

export function upgradePlan(data, { tier = 'Pro', billing = 'Monthly', renews_at } = {}) {
  const months = billing === 'Yearly' ? 12 : 1;
  const renews = renews_at || (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    return d.getTime();
  })();
  data.plan = {
    ...data.plan,
    tier,
    billing,
    status: 'active',
    renews_at: renews,
    last_payment_at: now(),
  };
  return data.plan;
}

// ---- sample data ------------------------------------------------------------------------

export function hasSampleData(data) {
  return data.invoices.some((invoice) => invoice.is_sample) || data.clients.some((client) => client.is_sample);
}

/** Four clients and five invoices across every status, flagged as sample data. */
export function seedSampleData(data) {
  if (hasSampleData(data) || data.invoices.length) return data;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const day = 86400000;
  const at = (offset) => today.getTime() + offset * day;

  const make = (name, phone, email, address) =>
    newClient(data, { name, phone, email, address, is_sample: true });

  const ada = make('Ada Nwosu', '08031234567', 'ada.nwosu@example.com', '12 Ademola Street, Ikoyi, Lagos');
  const tunde = make('Tunde Bakare', '08124567890', 'tunde.bakare@example.com', '8 Ogunlana Drive, Surulere, Lagos');
  const ngozi = make('Ngozi Eze', '07039876543', 'ngozi.eze@example.com', 'Plot 44 Gwarinpa Estate, Abuja');
  const musa = make('Musa Ibrahim', '09055678901', 'musa.ibrahim@example.com', '21 Ahmadu Bello Way, Kaduna');

  const line = (description, qty, naira) => ({ id: uid(), description, qty, unit_price: naira * 100 });

  const paid = newInvoice(data, {
    client_id: ada.id,
    number: 'INV-001',
    issue_date: at(-21),
    due_date: at(-14),
    items: [line('Wedding cake, 3 tiers', 1, 85000), line('Cupcakes (box of 12)', 3, 12000)],
    discount_kobo: 5000 * 100,
    vat_enabled: true,
    notes: 'Balance for the 24 October wedding. Thank you for your business.',
    status: STATUS.SENT,
    is_sample: true,
  });
  recordPayment(data, paid, {
    amount_kobo: invoiceTotal(paid),
    payment_date: at(-16),
    method: 'Transfer',
    reference: 'GTB-88213',
    note: 'Full payment received',
  });

  const partial = newInvoice(data, {
    client_id: tunde.id,
    number: 'INV-002',
    issue_date: at(-12),
    due_date: at(-5),
    items: [line('Bespoke 3-piece suit', 2, 95000), line('Alterations', 1, 8500)],
    notes: 'Fabric supplied by client. Pick up at the shop.',
    status: STATUS.SENT,
    is_sample: true,
  });
  recordPayment(data, partial, {
    amount_kobo: 100000 * 100,
    payment_date: at(-8),
    method: 'Bank transfer',
    reference: 'ZEN-4471',
    note: 'Deposit',
  });

  newInvoice(data, {
    client_id: ngozi.id,
    number: 'INV-003',
    issue_date: at(-4),
    due_date: at(3),
    items: [line('Studio portrait session (half day)', 1, 60000), line('Edited photos', 20, 1500)],
    notes: 'Includes 20 retouched images delivered by link.',
    status: STATUS.SENT,
    is_sample: true,
  });

  newInvoice(data, {
    client_id: musa.id,
    number: 'INV-004',
    issue_date: at(-2),
    due_date: at(5),
    items: [line('Bathroom plumbing - materials', 1, 42000), line('Labour (2 days)', 2, 15000)],
    discount_kobo: 2000 * 100,
    vat_enabled: true,
    notes: 'Payment on completion of the second bathroom.',
    status: STATUS.SENT,
    is_sample: true,
  });

  newInvoice(data, {
    client_id: ada.id,
    number: 'INV-005',
    issue_date: at(0),
    due_date: at(7),
    items: [line('Catering - 50 guests', 1, 150000)],
    vat_enabled: true,
    notes: 'Draft for the November event.',
    status: STATUS.DRAFT,
    is_sample: true,
  });

  return data;
}

export function removeSampleData(data) {
  const sampleInvoiceIds = new Set(data.invoices.filter((i) => i.is_sample).map((i) => i.id));
  data.invoices = data.invoices.filter((invoice) => !invoice.is_sample);
  data.clients = data.clients.filter((client) => !client.is_sample);
  data.payments = data.payments.filter((payment) => !sampleInvoiceIds.has(payment.invoice_id));
  data.receipts = data.receipts.filter((receipt) => !sampleInvoiceIds.has(receipt.invoice_id));
  renumberReceipts(data);
}

export function wipeData(accountId) {
  localStorage.removeItem(dataKey(accountId));
}

export { uid };
