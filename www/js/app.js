/**
 * InvoiceNaija — application shell and screens.
 *
 * One file, one state object, a tiny router and event delegation. Screens are rendered as HTML
 * strings and every interaction goes through data-act attributes, which keeps the code readable and
 * means there is exactly one click handler to reason about.
 */

import * as R from './rules.js';
import * as S from './store.js';
import { parseToKobo, format, compact, forInput, plain } from './money.js';
import {
  invoiceDocHtml,
  receiptDocHtml,
  invoiceFilename,
  receiptFilename,
  documentToPdf,
  deliverPdf,
} from './pdf.js';
import * as Paystack from './paystack.js';

const appEl = document.getElementById('app');
const tabbarEl = document.getElementById('tabbar');
const fabEl = document.getElementById('fab');
const toastEl = document.getElementById('toast');
const modalEl = document.getElementById('modal-root');
const cfg = () => window.INVOICENAIJA_CONFIG || {};
const VERSION = () => cfg().appVersion || '0.2.0-beta';

const state = {
  account: null,
  data: null,
  screen: { name: 'dashboard' },
  history: [],
  tab: 'dashboard',
  filter: 'All',
  query: '',
  draft: null,
  booted: false,
};

// ---- small helpers ----------------------------------------------------------------------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const clientOf = (id) => state.data?.clients.find((client) => client.id === id) || null;
const invoiceOf = (id) => state.data?.invoices.find((invoice) => invoice.id === id) || null;
const paymentsOf = (invoiceId) => state.data.payments.filter((payment) => payment.invoice_id === invoiceId);
const totalsOf = (invoice) => R.invoiceTotals(invoice);
const paidOf = (invoice) => R.collectedOn(invoice, state.data.payments);
const balanceOf = (invoice) => R.balanceDue(invoice, state.data.payments);
const statusOf = (invoice) => R.effectiveStatus(invoice, state.data.payments);
const save = () => state.account && S.saveData(state.account.id, state.data);
const proUser = () => R.isPro(state.data?.plan);
const formatDate = (ms) => R.shortDate(ms);

function toast(message, kind = 'ok') {
  toastEl.textContent = message;
  toastEl.className = `toast show${kind === 'error' ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3200);
}

function pillFor(status) {
  const cls = {
    [R.STATUS.PAID]: 'pill-paid',
    [R.STATUS.SENT]: 'pill-sent',
    [R.STATUS.OVERDUE]: 'pill-overdue',
    [R.STATUS.PARTIAL]: 'pill-partial',
    [R.STATUS.DRAFT]: 'pill-draft',
  }[status] || 'pill-draft';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

function statusClass(status) {
  return {
    [R.STATUS.PAID]: 'paid',
    [R.STATUS.SENT]: 'sent',
    [R.STATUS.OVERDUE]: 'late',
    [R.STATUS.PARTIAL]: 'partial',
    [R.STATUS.DRAFT]: 'draft',
  }[status] || 'draft';
}

function avatarFor(name) {
  return `<div class="avatar">${esc((name || '?').trim().charAt(0).toUpperCase())}</div>`;
}

// ---- router -----------------------------------------------------------------------------

function go(name, params = {}) {
  state.history.push(state.screen);
  state.screen = { name, ...params };
  render();
  window.scrollTo({ top: 0 });
}

function back() {
  state.screen = state.history.pop() || { name: state.tab || 'dashboard' };
  render();
  window.scrollTo({ top: 0 });
}

function setTab(tab) {
  state.tab = tab;
  state.history = [];
  state.screen = { name: tab };
  render();
  window.scrollTo({ top: 0 });
}

// ---- modal ------------------------------------------------------------------------------

function openModal(html) {
  modalEl.innerHTML = `<div class="modal-backdrop"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  scaleDocs();
}

function closeModal() {
  modalEl.innerHTML = '';
  document.body.style.overflow = '';
}

/** Scales every invoice/receipt preview to the width of its container. */
function scaleDocs() {
  document.querySelectorAll('.doc-wrap').forEach((wrap) => {
    const scaler = wrap.querySelector('.doc-scaler');
    const doc = wrap.querySelector('.doc');
    if (!scaler || !doc) return;
    const available = wrap.clientWidth - 16;
    const scale = Math.max(0.25, available / 794);
    scaler.style.transform = `scale(${scale})`;
    wrap.style.height = `${Math.round(doc.offsetHeight * scale) + 16}px`;
  });
}

// ---- notifications ----------------------------------------------------------------------

async function askNotificationPermission() {
  if (!('Notification' in window)) {
    toast('This browser has no notification support', 'error');
    return;
  }
  const result = await Notification.requestPermission();
  toast(result === 'granted' ? 'Notifications on' : 'Notifications not allowed');
}

function systemNotify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: './icons/icon-192.png', tag: title });
    }
  } catch (error) {
    /* Notifications are a bonus, never a blocker. */
  }
}

function pushNotification(title, body, { system = true } = {}) {
  S.notify(state.data, title, body);
  if (system) systemNotify(title, body);
}

function refreshFollowUpNotifications() {
  const followUps = R.dueReminders(
    state.data.invoices,
    state.data.payments,
    state.data.business.reminder_schedule,
    Date.now(),
    state.data.reminder_log
  );
  const actionable = followUps.filter((entry) => !entry.alreadySentToday);
  if (!actionable.length) return [];
  const title =
    actionable.length === 1 ? '1 invoice needs follow-up' : `${actionable.length} invoices need follow-up`;
  const today = R.startOfDay(Date.now());
  const already = state.data.notifications.some(
    (notification) => notification.title === title && R.startOfDay(notification.at) === today
  );
  if (!already) pushNotification(title, 'Open InvoiceNaija to send the reminder on WhatsApp.');
  return actionable;
}

// ---- screens: auth ----------------------------------------------------------------------

function renderAuth() {
  appEl.className = 'app no-tabs';
  tabbarEl.hidden = true;
  fabEl.hidden = true;
  appEl.innerHTML = `
    <div class="auth">
      <div class="auth-brand">
        <div class="auth-mark">₦</div>
        <div>
          <div style="font-weight:750;color:var(--green)">InvoiceNaija</div>
          <div class="sub">Invoices in 30 seconds</div>
        </div>
      </div>
      <h1>Create, send and track professional invoices.</h1>
      <p class="lede">Built for Nigerian freelancers and artisans. Naira only, works offline, and your clients get a clean PDF they can pay from.</p>

      <div class="field">
        <label class="label" for="auth-phone">Phone number</label>
        <input id="auth-phone" inputmode="tel" autocomplete="tel" placeholder="0803 123 4567" />
      </div>
      <div class="field">
        <label class="label" for="auth-pin">PIN (4 to 6 digits)</label>
        <input id="auth-pin" inputmode="numeric" type="password" autocomplete="current-password" placeholder="••••" />
        <div class="hint">Your PIN is stored on this device only, hashed. Nothing leaves your phone.</div>
      </div>
      <div id="auth-error" class="error"></div>

      <div class="spacer"></div>
      <button class="btn btn-primary" data-act="auth-signup">Create account</button>
      <div class="spacer" style="height:10px"></div>
      <button class="btn btn-outline" data-act="auth-signin">I already have an account</button>

      <div class="divider-text">or</div>
      <button class="google-btn" data-act="auth-google">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.7 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.8 6.1C12.2 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-2.8-.4-4.1H24v8.3h12.5c-.3 2-1.7 5-4.8 7l7.5 5.8c4.4-4.1 6.9-10.1 6.9-17z"/><path fill="#FBBC05" d="M10.3 28.7A14.6 14.6 0 019.5 24c0-1.6.3-3.2.8-4.7l-7.8-6.1A24 24 0 000 24c0 3.9.9 7.5 2.5 10.8l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2 1.4-4.8 2.4-8.4 2.4-6.4 0-11.8-3.7-13.7-9.1l-7.8 6.1C6.4 42.6 14.6 48 24 48z"/></svg>
        Continue with Google
      </button>

      <div class="auth-foot">
        InvoiceNaija keeps your invoices on this device. <br />
        Version ${esc(VERSION())}
      </div>
    </div>`;
}

async function doAuth(mode) {
  const phone = document.getElementById('auth-phone')?.value || '';
  const pin = document.getElementById('auth-pin')?.value || '';
  const errorEl = document.getElementById('auth-error');
  try {
    errorEl.textContent = '';
    state.account = mode === 'signup' ? await S.auth.signUp(phone, pin) : await S.auth.signIn(phone, pin);
    loadAccount();
    render();
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

function doGoogle() {
  const clientId = String(cfg().googleClientId || '').trim();
  if (!clientId) {
    openModal(`
      <div class="grab"></div>
      <div class="sheet-head"><h2>Google sign-in not configured</h2></div>
      <p class="sub">This build has no Google OAuth client ID, so the button cannot finish a real sign-in. Phone + PIN works fully offline.</p>
      <div class="notice info" style="margin:12px 0">To switch it on, add an OAuth Web client ID to <code>www/config.js</code> as <code>googleClientId</code> and add the app's domain to the authorised origins. Steps are in docs/BUILD.md.</div>
      <button class="btn btn-outline" data-act="close-modal">Close</button>
    `);
    return;
  }
  // Real Google Identity Services flow.
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.onload = () => {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async (response) => {
        const payload = JSON.parse(atob(response.credential.split('.')[1]));
        state.account = await S.auth.signInWithGoogle(payload.email, payload.name);
        loadAccount();
        render();
      },
    });
    window.google.accounts.id.prompt();
  };
  document.head.appendChild(script);
}

// ---- screens: onboarding ----------------------------------------------------------------

function renderOnboarding() {
  const business = state.data.business;
  appEl.className = 'app no-tabs';
  tabbarEl.hidden = true;
  fabEl.hidden = true;
  appEl.innerHTML = `
    <div class="screen">
      <div class="label">Step 1 of 2</div>
      <h1 class="page">Your business details</h1>
      <p class="sub">These print on every invoice. You can change them any time in Settings.</p>

      <div class="field">
        <label class="label" for="ob-name">Business name</label>
        <input id="ob-name" value="${esc(business.business_name)}" placeholder="Ada Cakes & Catering" />
      </div>
      <div class="field">
        <label class="label" for="ob-phone">Phone</label>
        <input id="ob-phone" inputmode="tel" value="${esc(business.phone)}" placeholder="0803 123 4567" />
      </div>
      <div class="field">
        <label class="label" for="ob-whatsapp">WhatsApp</label>
        <input id="ob-whatsapp" inputmode="tel" value="${esc(business.whatsapp)}" placeholder="0803 123 4567" />
      </div>
      <div class="field">
        <label class="label" for="ob-address">Business address</label>
        <input id="ob-address" value="${esc(business.address)}" placeholder="12 Ademola Street, Ikoyi, Lagos" />
      </div>
      <div class="field">
        <label class="label" for="ob-bank">Bank name</label>
        <input id="ob-bank" value="${esc(business.bank_name)}" placeholder="Guaranty Trust Bank" />
      </div>
      <div class="field">
        <label class="label" for="ob-account-number">Account number</label>
        <input id="ob-account-number" inputmode="numeric" maxlength="10" value="${esc(business.account_number)}" placeholder="0123456789" />
        <div class="hint">10 digits. Shown on the invoice with the Pay Now prompt.</div>
      </div>
      <div class="field">
        <label class="label" for="ob-account-name">Account name</label>
        <input id="ob-account-name" value="${esc(business.account_name)}" placeholder="Ada Nwosu" />
      </div>
      <div id="ob-error" class="error"></div>
      <div class="spacer"></div>
      <button class="btn btn-accent" data-act="onboard-save">Start invoicing</button>
      <div class="spacer" style="height:10px"></div>
      <p class="hint">Logo upload, invoice prefix and the reminder template live in Settings.</p>
    </div>`;
}

function saveOnboarding() {
  const value = (id) => document.getElementById(id)?.value?.trim() || '';
  const name = value('ob-name');
  const errorEl = document.getElementById('ob-error');
  const account = R.normalizeAccountNumber(value('ob-account-number'));
  if (!name) {
    errorEl.textContent = 'Enter your business name';
    return;
  }
  if (!account.ok && value('ob-account-number')) {
    errorEl.textContent = account.message;
    return;
  }
  state.data.business = {
    ...state.data.business,
    business_name: name,
    phone: value('ob-phone'),
    whatsapp: value('ob-whatsapp') || value('ob-phone'),
    address: value('ob-address'),
    bank_name: value('ob-bank'),
    account_number: account.value,
    account_name: value('ob-account-name'),
  };
  S.seedSampleData(state.data);
  save();
  toast('Business profile saved');
  setTab('dashboard');
}

// ---- screens: dashboard -----------------------------------------------------------------

function renderTabbar() {
  const tabs = [
    { key: 'dashboard', label: 'Home', icon: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z' },
    { key: 'invoices', label: 'Invoices', icon: 'M6 2h9l5 5v15H6zM15 3.5V7h3.5zM8.5 11h7v1.6h-7zM8.5 14.5h7V16h-7z' },
    { key: 'clients', label: 'Clients', icon: 'M9 11a4 4 0 110-8 4 4 0 010 8zm0 2c4 0 7 2 7 4.5V21H2v-3.5C2 15 5 13 9 13zm8.5-2a3 3 0 110-6 3 3 0 010 6zM24 21h-6v-3.5c0-1.6-.7-3-1.8-4 3.3.2 5.8 1.9 5.8 4z' },
    { key: 'settings', label: 'Settings', icon: 'M12 8.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM19.4 13a7.6 7.6 0 000-2l2-1.5-2-3.4-2.3 1a7.4 7.4 0 00-1.8-1L15 3.6h-4l-.3 2.5a7.4 7.4 0 00-1.8 1l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 000 2l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 001.8 1l.3 2.5h4l.3-2.5a7.4 7.4 0 001.8-1l2.3 1 2-3.4z' },
  ];
  const unread = state.data?.notifications.some((notification) => !notification.read);
  tabbarEl.hidden = false;
  tabbarEl.innerHTML = tabs
    .map(
      (tab) => `
      <button class="tab ${state.screen.name === tab.key ? 'active' : ''}" data-act="tab" data-id="${tab.key}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${tab.icon}" /></svg>
        <span>${tab.label}</span>
        ${tab.key === 'dashboard' && unread ? '<span class="dot"></span>' : ''}
      </button>`
    )
    .join('');
}

function renderDashboard() {
  const data = state.data;
  const stats = R.computeStats(data.invoices, data.payments);
  const months = R.collectionsByMonth(data.invoices, data.payments);
  const max = Math.max(...months.map((month) => month.amount), 1);
  const followUps = R.dueReminders(data.invoices, data.payments, data.business.reminder_schedule, Date.now(), data.reminder_log);
  const usage = R.canCreateInvoice(data);
  const recent = data.invoices.slice(0, 4);
  const businessName = data.business.business_name || 'Your business';

  appEl.className = 'app';
  appEl.innerHTML = `
    <div class="screen">
      <div class="row between">
        <div class="grow">
          <div class="sub">Welcome back</div>
          <h1 class="page truncate">${esc(businessName)}</h1>
        </div>
        <button class="icon-btn" data-act="notifications" aria-label="Notifications" style="width:44px;height:44px;font-size:19px;background:var(--surface)">
          🔔${data.notifications.some((n) => !n.read) ? '<span style="position:absolute;transform:translate(12px,-12px);width:8px;height:8px;border-radius:50%;background:var(--orange)"></span>' : ''}
        </button>
      </div>

      ${stats.overdueCount ? `<div class="alert" data-act="filter-invoices" data-id="Overdue">⚠️ ${stats.overdueCount} invoice${stats.overdueCount === 1 ? '' : 's'} overdue • ${format(stats.overdueAmount)} <span class="grow"></span>›</div>` : ''}
      ${!proUser() && usage.limit ? `<div class="alert warn">Free plan: ${usage.used} of ${usage.limit} invoices used this month <span class="grow"></span><button class="btn btn-sm btn-accent" data-act="upgrade">Upgrade</button></div>` : ''}
      ${proUser() ? `<div class="alert info">⭐ Pro plan • ${esc(data.plan.billing || 'Monthly')} • renews ${formatDate(data.plan.renews_at)}</div>` : ''}
      ${S.hasSampleData(data) ? `<div class="badge-sample">Sample data — remove it in Settings → Your data</div>` : ''}

      <div class="stats">
        <div class="stat"><div class="label">Total invoiced</div><div class="value">${compact(stats.invoiced)}</div><div class="note">${stats.count} invoice${stats.count === 1 ? '' : 's'}</div></div>
        <div class="stat paid"><div class="label">Total paid</div><div class="value">${compact(stats.paid)}</div><div class="note">received</div></div>
        <div class="stat out"><div class="label">Outstanding</div><div class="value">${compact(stats.outstanding)}</div><div class="note">balances due</div></div>
        <div class="stat month"><div class="label">Collected this month</div><div class="value">${compact(stats.collectedThisMonth)}</div><div class="note">${formatDate(Date.now())}</div></div>
        <div class="stat partial"><div class="label">Partially paid</div><div class="value">${stats.partialCount}</div><div class="note">still owing</div></div>
        <div class="stat late"><div class="label">Overdue</div><div class="value">${stats.overdueCount}</div><div class="note">${stats.overdueCount ? format(stats.overdueAmount) + ' late' : 'nothing late'}</div></div>
      </div>

      <div class="section-head"><h2>Collections</h2><span class="sub">last 6 months</span></div>
      <div class="card">
        <div class="chart">
          ${months
            .map(
              (month, index) => `
            <div class="col ${index === months.length - 1 ? 'latest' : ''}">
              <div class="bar-value">${month.amount ? compact(month.amount).replace('₦', '') : ''}</div>
              <div class="bar-track"><div class="bar" style="height:${Math.max(3, Math.round((month.amount / max) * 100))}%"></div></div>
              <div class="bar-label">${esc(month.label)}</div>
            </div>`
            )
            .join('')}
        </div>
      </div>

      <div class="section-head"><h2>Needs follow-up</h2>${followUps.length ? `<span class="sub">${followUps.length}</span>` : ''}</div>
      ${
        followUps.length
          ? `<div class="list">${followUps
              .slice(0, 5)
              .map(
                (entry) => `
            <div class="list-item">
              <div class="grow">
                <div class="title truncate">${esc(clientOf(entry.invoice.client_id)?.name || 'Client')}</div>
                <div class="meta">${esc(entry.invoice.number)} • ${esc(entry.reason)} • ${format(entry.balance)}</div>
              </div>
              <button class="btn btn-sm btn-outline" data-act="remind" data-id="${entry.invoice.id}">Remind</button>
            </div>`
              )
              .join('')}</div>`
          : `<div class="empty"><h3>Nothing to chase</h3><p>No invoice needs a reminder today.</p></div>`
      }

      <div class="section-head"><h2>Recent invoices</h2><button class="link" data-act="tab" data-id="invoices">See all</button></div>
      ${
        recent.length
          ? `<div class="list">${recent.map(invoiceRowHtml).join('')}</div>`
          : `<div class="empty"><h3>No invoices yet</h3><p>Create your first invoice and get paid faster.</p><button class="btn btn-accent" data-act="new-invoice">Create invoice</button></div>`
      }
      <div class="spacer"></div>
      <p class="hint">Invoices are stored on this device. Share them on WhatsApp or email the PDF.</p>
    </div>`;
}

function invoiceRowHtml(invoice, { swipe = false } = {}) {
  const client = clientOf(invoice.client_id);
  const status = statusOf(invoice);
  const balance = balanceOf(invoice);
  const total = totalsOf(invoice).total;
  const showBalance = balance > 0 && balance < total;
  const body = `
    <button class="list-item" data-act="open-invoice" data-id="${invoice.id}">
      <div class="grow">
        <div class="title truncate">${esc(client?.name || 'No client')}</div>
        <div class="meta truncate">${esc(invoice.number)} • ${esc(uiDueText(invoice))}</div>
        ${showBalance ? `<div class="meta">Balance ${format(balance)} of ${format(total)}</div>` : ''}
      </div>
      <div style="text-align:right;display:flex;flex-direction:column;gap:4px;align-items:flex-end">
        <span class="amount ${statusClass(status)}">${format(showBalance ? balance : total)}</span>
        ${pillFor(status)}
      </div>
    </button>`;
  if (!swipe || status === R.STATUS.PAID) return body;
  return `<div class="swipe" data-swipe="${invoice.id}">
      <div class="swipe-action" data-act="quick-paid" data-id="${invoice.id}">Mark paid</div>
      ${body}
    </div>`;
}

function uiDueText(invoice) {
  if (invoice.status === R.STATUS.PAID || balanceOf(invoice) === 0) {
    return `Paid ${formatDate(invoice.paid_at || invoice.issue_date)}`;
  }
  return R.relativeDue(invoice.due_date);
}

// ---- screens: invoices list -------------------------------------------------------------

function renderInvoices() {
  const filters = ['All', 'Draft', 'Sent', 'Partially Paid', 'Paid', 'Overdue'];
  let invoices = state.data.invoices.slice();
  if (state.filter !== 'All') invoices = invoices.filter((invoice) => statusOf(invoice) === state.filter);
  if (state.query) {
    const query = state.query.toLowerCase();
    invoices = invoices.filter(
      (invoice) =>
        (clientOf(invoice.client_id)?.name || '').toLowerCase().includes(query) ||
        invoice.number.toLowerCase().includes(query)
    );
  }
  const total = invoices
    .filter((invoice) => invoice.status !== R.STATUS.DRAFT)
    .reduce((sum, invoice) => sum + balanceOf(invoice), 0);

  appEl.className = 'app';
  appEl.innerHTML = `
    <div class="screen">
      <h1 class="page">Invoices</h1>
      <p class="sub">${invoices.length} shown • ${format(total)} in balances</p>
      <div class="field search">
        <input id="invoice-search" placeholder="Search client or invoice number" value="${esc(state.query)}" data-field="search" />
      </div>
      <div class="pill-row" style="margin-top:10px">
        ${filters
          .map(
            (filter) =>
              `<button class="chip ${state.filter === filter ? 'active' : ''}" data-act="filter" data-id="${esc(filter)}">${esc(filter)}</button>`
          )
          .join('')}
      </div>
      <div class="spacer"></div>
      ${
        invoices.length
          ? `<div class="list">${invoices
              .map((invoice, index) =>
                (index ? '<div class="divider"></div>' : '') + invoiceRowHtml(invoice, { swipe: true })
              )
              .join('')}</div>
             <p class="hint">Swipe an unpaid invoice to mark it paid, or open it to record a partial payment.</p>`
          : `<div class="empty"><h3>${state.query ? 'No matches' : 'Nothing here yet'}</h3>
               <p>${state.query ? 'Try a different name or invoice number.' : 'Invoices you create will show up here.'}</p>
               ${state.query ? '' : '<button class="btn btn-accent" data-act="new-invoice">New invoice</button>'}</div>`
      }
      <div class="spacer"></div>
    </div>`;
}

// ---- screens: editor --------------------------------------------------------------------

function itemRowHtml(item, index) {
  return `
    <div class="item-row" data-item="${index}">
      <input placeholder="Description e.g. Tailored agbada" value="${esc(item.description)}" data-field="item-desc" data-idx="${index}" />
      <div class="item-grid">
        <input inputmode="numeric" placeholder="Qty" value="${esc(item.qty)}" data-field="item-qty" data-idx="${index}" aria-label="Quantity" />
        <input inputmode="decimal" placeholder="Unit price" value="${esc(forInput(item.unit_price))}" data-field="item-price" data-idx="${index}" aria-label="Unit price" />
        <button class="icon-btn" data-act="remove-item" data-idx="${index}" aria-label="Remove item">✕</button>
      </div>
      <div class="sub" style="margin-top:6px">Amount: <b id="item-amount-${index}">${format(Math.round((item.qty || 0) * (item.unit_price || 0)))}</b></div>
    </div>`;
}

function renderEditor() {
  const draft = state.draft;
  const client = clientOf(draft.client_id);
  const isNew = !draft.id;
  appEl.className = 'app no-tabs';
  tabbarEl.hidden = true;
  fabEl.hidden = true;

  appEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="back" data-act="back" aria-label="Back">←</button>
        <h1>${isNew ? 'New invoice' : 'Edit invoice'}</h1>
      </div>

      <div class="row between">
        <span class="pill pill-draft">${esc(draft.number)}</span>
        <span class="sub">${esc(draft.status)}</span>
      </div>

      <div class="field">
        <label class="label" for="ed-client">Client</label>
        <select id="ed-client" data-field="client">
          <option value="">Choose client…</option>
          ${state.data.clients
            .map(
              (option) =>
                `<option value="${option.id}" ${option.id === draft.client_id ? 'selected' : ''}>${esc(option.name)}${option.phone ? ` • ${esc(option.phone)}` : ''}</option>`
            )
            .join('')}
          <option value="__new">＋ Add new client</option>
        </select>
      </div>

      <div class="section-head"><h2>Items</h2></div>
      <div id="items-host">${draft.items.map(itemRowHtml).join('')}</div>
      <button class="btn btn-outline" data-act="add-item">+ Add item</button>

      <div class="field">
        <label class="label" for="ed-discount">Discount (₦)</label>
        <input id="ed-discount" inputmode="decimal" placeholder="0" value="${esc(forInput(draft.discount_kobo))}" data-field="discount" />
      </div>

      <div class="switch-row" style="margin-top:14px">
        <div class="grow">
          <div style="font-weight:650">Add VAT (7.5%)</div>
          <div class="sub">Charged on the amount after discount</div>
        </div>
        <div class="switch ${draft.vat_enabled ? 'on' : ''}" data-act="toggle-vat" role="switch" aria-checked="${draft.vat_enabled}" aria-label="Add VAT"></div>
      </div>

      <div class="field">
        <label class="label" for="ed-due">Due date</label>
        <input id="ed-due" type="date" value="${R.isoDate(draft.due_date)}" data-field="due" />
      </div>

      <div class="field">
        <label class="label" for="ed-notes">Notes</label>
        <textarea id="ed-notes" placeholder="Notes for the client (optional)" data-field="notes">${esc(draft.notes)}</textarea>
      </div>

      <div class="section-head"><h2>Summary</h2></div>
      <div class="card tint totals" id="totals-box">${totalsBoxHtml(draft)}</div>

      <div class="spacer"></div>
      <button class="btn btn-primary" data-act="editor-save" data-id="send">Save & preview</button>
      <div class="spacer" style="height:10px"></div>
      <button class="btn btn-outline" data-act="editor-save" data-id="draft">Save as draft</button>
      <div class="spacer"></div>
    </div>`;
}

function totalsBoxHtml(draft) {
  const totals = R.totals(draft.items, draft.discount_kobo, draft.vat_enabled);
  return `
    <div class="row"><span>Subtotal</span><span class="amount">${format(totals.subtotal)}</span></div>
    ${totals.discount ? `<div class="row"><span>Discount</span><span class="amount">-${format(totals.discount)}</span></div>` : ''}
    ${draft.vat_enabled ? `<div class="row"><span>VAT (7.5%)</span><span class="amount">${format(totals.vat)}</span></div>` : ''}
    <div class="row total"><span>Total</span><span class="amount">${format(totals.total)}</span></div>`;
}

function syncEditorFromDom() {
  const draft = state.draft;
  document.querySelectorAll('[data-field^="item-"]').forEach((input) => {
    const index = Number(input.dataset.idx);
    const item = draft.items[index];
    if (!item) return;
    if (input.dataset.field === 'item-desc') item.description = input.value;
    if (input.dataset.field === 'item-qty') item.qty = Math.max(0, Number.parseInt(input.value, 10) || 0);
    if (input.dataset.field === 'item-price') item.unit_price = parseToKobo(input.value);
  });
  const discount = document.querySelector('[data-field="discount"]');
  if (discount) draft.discount_kobo = parseToKobo(discount.value);
  const notes = document.querySelector('[data-field="notes"]');
  if (notes) draft.notes = notes.value;
}

function updateEditorNumbers() {
  const draft = state.draft;
  draft.items.forEach((item, index) => {
    const el = document.getElementById(`item-amount-${index}`);
    if (el) el.textContent = format(Math.round((item.qty || 0) * (item.unit_price || 0)));
  });
  const totalsBox = document.getElementById('totals-box');
  if (totalsBox) totalsBox.innerHTML = totalsBoxHtml(draft);
}

function openEditor(invoiceId) {
  if (invoiceId) {
    const invoice = invoiceOf(invoiceId);
    if (!invoice) return;
    state.draft = JSON.parse(JSON.stringify(invoice));
    state.draft.isExisting = true;
  } else {
    const usage = R.canCreateInvoice(state.data);
    if (!usage.allowed) {
      renderUpgrade(null, { reason: 'limit' });
      return;
    }
    const today = R.startOfDay(Date.now());
    state.draft = {
      client_id: '',
      number: R.nextNumber(state.data.business.invoice_prefix, state.data.invoices.map((invoice) => invoice.number)),
      issue_date: today,
      due_date: R.addDays(today, 7),
      items: [{ description: '', qty: 1, unit_price: 0 }],
      discount_kobo: 0,
      vat_enabled: state.data.business.vat_default,
      notes: '',
      status: R.STATUS.SENT,
    };
  }
  go('editor');
}

function saveEditor(asDraft) {
  syncEditorFromDom();
  const draft = state.draft;
  const client = clientOf(draft.client_id);
  if (!client) {
    toast('Choose or add a client first', 'error');
    return;
  }
  const items = draft.items.filter((item) => (item.description || '').trim() || item.unit_price > 0);
  if (!items.length) {
    toast('Add at least one item with a price', 'error');
    return;
  }
  const totals = R.totals(items, draft.discount_kobo, draft.vat_enabled);

  if (draft.isExisting) {
    const existing = invoiceOf(draft.id);
    Object.assign(existing, {
      client_id: draft.client_id,
      items,
      discount_kobo: draft.discount_kobo,
      vat_enabled: draft.vat_enabled,
      notes: draft.notes,
      due_date: draft.due_date,
      balance_due: Math.max(0, totals.total - paidOf(existing)),
    });
    if (paidOf(existing) >= totals.total && totals.total > 0) existing.status = R.STATUS.PAID;
    else if (existing.status === R.STATUS.PAID) existing.status = R.STATUS.SENT;
    save();
    toast('Invoice updated');
    go('preview', { invoiceId: existing.id });
    return;
  }

  const usage = R.canCreateInvoice(state.data);
  if (!usage.allowed) {
    renderUpgrade(null, { reason: 'limit' });
    return;
  }
  const invoice = S.newInvoice(state.data, {
    client_id: draft.client_id,
    number: draft.number,
    issue_date: draft.issue_date,
    due_date: draft.due_date,
    items,
    discount_kobo: draft.discount_kobo,
    vat_enabled: draft.vat_enabled,
    notes: draft.notes,
    status: asDraft ? R.STATUS.DRAFT : R.STATUS.SENT,
  });
  save();
  if (asDraft) {
    toast('Saved as draft');
    setTab('invoices');
  } else {
    toast(`${invoice.number} created`);
    go('preview', { invoiceId: invoice.id });
  }
}

// ---- screens: preview -------------------------------------------------------------------

function renderPreview(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  if (!invoice) {
    setTab('invoices');
    return;
  }
  const client = clientOf(invoice.client_id);
  const status = statusOf(invoice);
  const totals = totalsOf(invoice);
  const paid = paidOf(invoice);
  const balance = balanceOf(invoice);
  const payments = paymentsOf(invoice.id).slice().sort((a, b) => b.payment_date - a.payment_date);
  const receipts = state.data.receipts.filter((receipt) => receipt.invoice_id === invoice.id);
  const brandable = R.canBrandPdf(state.data, invoice);

  appEl.className = 'app no-tabs';
  tabbarEl.hidden = true;
  fabEl.hidden = true;
  appEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="back" data-act="back" aria-label="Back">←</button>
        <h1>${esc(invoice.number)}</h1>
        <button class="icon-btn" data-act="invoice-menu" data-id="${invoice.id}" aria-label="More actions" style="width:44px;height:44px;font-size:20px">⋯</button>
      </div>

      <div class="row between">
        <div class="grow">
          <div style="font-weight:650">${esc(client?.name || 'No client')}</div>
          <div class="sub">${esc(uiDueText(invoice))}</div>
        </div>
        ${pillFor(status)}
      </div>

      <div class="paybar">
        <div class="progress-track"><div class="progress-fill" style="width:${totals.total ? Math.round((paid / totals.total) * 100) : 0}%"></div></div>
        <div class="legend">
          <span>${format(paid)} of ${format(totals.total)} paid</span>
          <span>${balance > 0 ? `Balance ${format(balance)}` : 'Fully paid'}</span>
        </div>
      </div>

      <div class="spacer"></div>
      <div class="doc-wrap"><div class="doc-scaler">${invoiceDocHtml({ business: state.data.business, client, invoice, payments, brandable })}</div></div>

      <div class="spacer"></div>
      <button class="btn btn-accent" data-act="share-invoice" data-id="${invoice.id}">Share on WhatsApp</button>
      <div class="spacer" style="height:10px"></div>
      <div class="btn-row">
        <button class="btn btn-outline" data-act="download-invoice" data-id="${invoice.id}">Download PDF</button>
        <button class="btn btn-outline" data-act="email-invoice" data-id="${invoice.id}">Email</button>
      </div>
      <div class="spacer" style="height:10px"></div>
      ${balance > 0 ? `<div class="btn-row">
        <button class="btn btn-primary" data-act="record-payment" data-id="${invoice.id}">Record payment</button>
        <button class="btn btn-outline" data-act="remind" data-id="${invoice.id}">Send reminder</button>
      </div>` : `<button class="btn btn-outline" data-act="remind" data-id="${invoice.id}">Send a thank-you / payment confirmation</button>`}
      <div class="spacer" style="height:10px"></div>
      <div class="btn-row">
        <button class="btn btn-outline" data-act="edit-invoice" data-id="${invoice.id}">Edit</button>
        <button class="btn btn-outline" data-act="make-recurring" data-id="${invoice.id}">Make recurring</button>
      </div>
      ${!brandable ? `<div class="notice test" style="margin-top:12px">
        Free plan: this PDF is unbranded. <button class="link-btn" data-act="unlock-pdf" data-id="${invoice.id}">Unlock logo &amp; colours for ₦200</button>, or upgrade to Pro.
      </div>` : ''}

      <div class="section-head"><h2>Payments</h2><span class="sub">${payments.length}</span></div>
      ${
        payments.length
          ? `<div class="list">${payments
              .map((payment) => {
                const receipt = receipts.find((candidate) => candidate.payment_id === payment.id);
                return `<div class="list-item">
                  <div class="grow">
                    <div class="title">${format(payment.amount_kobo)}</div>
                    <div class="meta">${esc(payment.method)} • ${formatDate(payment.payment_date)}${payment.reference ? ` • ${esc(payment.reference)}` : ''}</div>
                  </div>
                  ${receipt ? `<button class="btn btn-sm btn-outline" data-act="open-receipt" data-id="${receipt.id}">${esc(receipt.receipt_number)}</button>` : ''}
                </div>`;
              })
              .join('')}</div>`
          : `<div class="empty"><h3>No payments yet</h3><p>Record a deposit or full payment and the receipt is created automatically.</p></div>`
      }

      ${
        state.data.reminder_log.filter((log) => log.invoice_id === invoice.id).length
          ? `<div class="section-head"><h2>Reminders sent</h2></div>
             <div class="card tint">
               ${state.data.reminder_log
                 .filter((log) => log.invoice_id === invoice.id)
                 .slice(-4)
                 .reverse()
                 .map((log) => `<div class="row between" style="padding:4px 0"><span class="sub">${esc(log.channel)}</span><span class="sub">${formatDate(log.sent_at)}</span></div>`)
                 .join('')}
             </div>`
          : ''
      }
      <div class="spacer"></div>
    </div>`;
}

// ---- payments & receipts ----------------------------------------------------------------

function openPaymentSheet(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  if (!invoice) return;
  const balance = balanceOf(invoice);
  if (balance <= 0) {
    toast('This invoice is already fully paid');
    return;
  }
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>Record payment</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <p class="sub">${esc(invoice.number)} • balance ${format(balance)}</p>
    <div class="field">
      <label class="label" for="pay-amount">Amount received (₦)</label>
      <input id="pay-amount" inputmode="decimal" value="${forInput(balance)}" autofocus />
      <div class="hint">Cannot be more than ${format(balance)}.</div>
    </div>
    <div class="field">
      <label class="label" for="pay-date">Payment date</label>
      <input id="pay-date" type="date" value="${R.isoDate(Date.now())}" max="${R.isoDate(Date.now())}" />
    </div>
    <div class="field">
      <label class="label" for="pay-method">Method</label>
      <select id="pay-method">
        ${R.PAYMENT_METHODS.map((method) => `<option value="${esc(method)}">${esc(method)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label class="label" for="pay-reference">Reference (optional)</label>
      <input id="pay-reference" placeholder="Transfer reference or POS slip" />
    </div>
    <div class="field">
      <label class="label" for="pay-note">Note (optional)</label>
      <input id="pay-note" placeholder="Deposit, balance, part payment…" />
    </div>
    <div id="pay-error" class="error"></div>
    <div class="spacer"></div>
    <button class="btn btn-primary" data-act="save-payment" data-id="${invoice.id}">Save payment &amp; issue receipt</button>
  `);
}

function savePayment(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const errorEl = document.getElementById('pay-error');
  const amountKobo = parseToKobo(document.getElementById('pay-amount').value);
  const dateValue = document.getElementById('pay-date').value;
  const dateMs = dateValue ? new Date(`${dateValue}T12:00:00`).getTime() : Date.now();
  const method = document.getElementById('pay-method').value;
  const reference = document.getElementById('pay-reference').value;
  const note = document.getElementById('pay-note').value;

  const check = R.validatePayment(invoice, state.data.payments, amountKobo, dateMs);
  if (!check.ok) {
    errorEl.textContent = check.message;
    return;
  }
  const { receipt } = S.recordPayment(state.data, invoice, {
    amount_kobo: amountKobo,
    payment_date: dateMs,
    method,
    reference,
    note,
  });
  save();
  closeModal();
  toast(`${format(amountKobo)} recorded • ${receipt.receipt_number} issued`);
  pushNotification('Payment recorded', `${receipt.receipt_number}: ${format(amountKobo)} on ${invoice.number}.`, { system: false });
  render();
  openReceiptSheet(receipt.id);
}

function openReceiptSheet(receiptId) {
  const receipt = state.data.receipts.find((candidate) => candidate.id === receiptId);
  if (!receipt) return;
  const invoice = invoiceOf(receipt.invoice_id);
  const payment = state.data.payments.find((candidate) => candidate.id === receipt.payment_id);
  const client = clientOf(invoice?.client_id);
  const brandable = R.canBrandPdf(state.data, invoice);
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>${esc(receipt.receipt_number)}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <div class="doc-wrap"><div class="doc-scaler">${receiptDocHtml({
      business: state.data.business,
      client,
      invoice,
      payment,
      receipt,
      payments: state.data.payments,
      brandable,
    })}</div></div>
    <div class="spacer"></div>
    <button class="btn btn-accent" data-act="share-receipt" data-id="${receipt.id}">Share on WhatsApp</button>
    <div class="spacer" style="height:10px"></div>
    <div class="btn-row">
      <button class="btn btn-outline" data-act="download-receipt" data-id="${receipt.id}">Download</button>
      <button class="btn btn-outline" data-act="email-receipt" data-id="${receipt.id}">Email</button>
    </div>
  `);
}

// ---- reminders ---------------------------------------------------------------------------

function openReminderSheet(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const client = clientOf(invoice.client_id);
  const message = R.reminderMessage(state.data.business.reminder_template, {
    business: state.data.business,
    client,
    invoice,
    balance: balanceOf(invoice),
  });
  const link = R.waLink(client?.phone, message);
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>Send reminder</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <p class="sub">${esc(client?.name || 'Client')} • ${esc(invoice.number)} • ${format(balanceOf(invoice))}</p>
    <div class="field">
      <label class="label" for="reminder-text">Message (edit before sending)</label>
      <textarea id="reminder-text" style="min-height:150px">${esc(message)}</textarea>
    </div>
    ${link ? '' : '<div class="notice test">This client has no phone number saved, so WhatsApp cannot open. Edit the client or copy the message.</div>'}
    <div class="spacer"></div>
    <button class="btn btn-accent" data-act="send-reminder-whatsapp" data-id="${invoice.id}" ${link ? '' : 'disabled'}>Open WhatsApp</button>
    <div class="spacer" style="height:10px"></div>
    <button class="btn btn-outline" data-act="copy-reminder" data-id="${invoice.id}">Copy message</button>
  `);
}

function sendReminderWhatsApp(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const client = clientOf(invoice.client_id);
  const text = document.getElementById('reminder-text')?.value || '';
  const link = R.waLink(client?.phone, text);
  if (!link) {
    toast('No WhatsApp number for this client', 'error');
    return;
  }
  S.logReminder(state.data, invoice.id, 'WhatsApp', text);
  save();
  closeModal();
  openExternal(link);
  toast('Reminder logged');
  render();
}

function openExternal(url) {
  if (window.Capacitor?.isNativePlatform?.()) {
    window.open(url, '_system');
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ---- screens: clients -------------------------------------------------------------------

function renderClients() {
  const clients = state.data.clients.slice().sort((a, b) => a.name.localeCompare(b.name));
  const totalOwed = clients.reduce((sum, client) => sum + R.owedByClient(state.data.invoices, state.data.payments, client.id), 0);
  appEl.className = 'app';
  appEl.innerHTML = `
    <div class="screen">
      <div class="row between">
        <div>
          <h1 class="page">Clients</h1>
          <p class="sub">${clients.length} client${clients.length === 1 ? '' : 's'} • ${format(totalOwed)} owed</p>
        </div>
        <button class="btn btn-sm btn-outline" data-act="add-client">+ Add</button>
      </div>
      ${
        clients.length
          ? `<div class="list">${clients
              .map((client) => {
                const owed = R.owedByClient(state.data.invoices, state.data.payments, client.id);
                const count = state.data.invoices.filter((invoice) => invoice.client_id === client.id).length;
                return `${'<div class="divider"></div>' && ''}
                <button class="list-item" data-act="open-client" data-id="${client.id}">
                  ${avatarFor(client.name)}
                  <div class="grow">
                    <div class="title truncate">${esc(client.name)}</div>
                    <div class="meta truncate">${esc(client.phone || 'No phone')} • ${count} invoice${count === 1 ? '' : 's'}</div>
                  </div>
                  <div style="text-align:right">
                    <div class="amount ${owed > 0 ? 'late' : 'paid'}">${owed > 0 ? format(owed) : 'Settled'}</div>
                    <div class="meta">${owed > 0 ? 'owed' : 'up to date'}</div>
                  </div>
                </button>`;
              })
              .join('')}</div>`
          : `<div class="empty"><h3>No clients yet</h3><p>Add a client once and reuse them on every invoice.</p><button class="btn btn-accent" data-act="add-client">Add client</button></div>`
      }
      <div class="spacer"></div>
    </div>`;
}

function openClientForm(clientId) {
  const client = clientId ? clientOf(clientId) : null;
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>${client ? 'Edit client' : 'Add client'}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <div class="field">
      <label class="label" for="cl-name">Client name</label>
      <input id="cl-name" value="${esc(client?.name || '')}" placeholder="Ada Nwosu" />
    </div>
    <div class="field">
      <label class="label" for="cl-phone">Phone (for WhatsApp)</label>
      <input id="cl-phone" inputmode="tel" value="${esc(client?.phone || '')}" placeholder="0803 123 4567" />
    </div>
    <div class="field">
      <label class="label" for="cl-email">Email (optional)</label>
      <input id="cl-email" type="email" value="${esc(client?.email || '')}" placeholder="client@example.com" />
    </div>
    <div class="field">
      <label class="label" for="cl-address">Address (optional)</label>
      <input id="cl-address" value="${esc(client?.address || '')}" placeholder="12 Ademola Street, Ikoyi" />
    </div>
    <div id="cl-error" class="error"></div>
    <div class="spacer"></div>
    <button class="btn btn-primary" data-act="save-client" data-id="${client?.id || ''}">Save client</button>
  `);
}

function saveClient(clientId) {
  const name = document.getElementById('cl-name').value.trim();
  const errorEl = document.getElementById('cl-error');
  if (!name) {
    errorEl.textContent = 'Enter a client name';
    return;
  }
  const fields = {
    name,
    phone: document.getElementById('cl-phone').value.trim(),
    email: document.getElementById('cl-email').value.trim(),
    address: document.getElementById('cl-address').value.trim(),
  };
  let client;
  if (clientId) {
    client = clientOf(clientId);
    Object.assign(client, fields);
  } else {
    client = S.newClient(state.data, fields);
  }
  if (state.screen.name === 'editor' && state.draft && !state.draft.client_id) {
    state.draft.client_id = client.id;
  }
  save();
  closeModal();
  render();
  toast(clientId ? 'Client updated' : 'Client added');
}

function openClientSheet(clientId) {
  const client = clientOf(clientId);
  if (!client) return;
  const invoices = state.data.invoices.filter((invoice) => invoice.client_id === client.id);
  const owed = R.owedByClient(state.data.invoices, state.data.payments, client.id);
  const receipts = state.data.receipts.filter((receipt) => invoices.some((invoice) => invoice.id === receipt.invoice_id));
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>${esc(client.name)}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <div class="label">Total owed</div>
    <div class="amount ${owed > 0 ? 'late' : 'paid'}" style="font-size:26px;margin-top:2px">${format(owed)}</div>
    <div class="sub" style="margin-top:8px">${esc(client.phone || 'No phone')}${client.email ? ` • ${esc(client.email)}` : ''}</div>
    ${client.address ? `<div class="sub">${esc(client.address)}</div>` : ''}

    <div class="spacer"></div>
    <div class="btn-row">
      <button class="btn btn-outline" data-act="call-client" data-id="${client.id}">Call</button>
      <button class="btn btn-outline" data-act="whatsapp-client" data-id="${client.id}">WhatsApp</button>
    </div>
    <div class="spacer" style="height:10px"></div>
    <button class="btn btn-primary" data-act="new-invoice-for" data-id="${client.id}">New invoice</button>

    <div class="section-head"><h2>Invoices</h2><span class="sub">${invoices.length}</span></div>
    ${
      invoices.length
        ? `<div class="list">${invoices
            .map(
              (invoice) => `<button class="list-item" data-act="open-invoice" data-id="${invoice.id}">
                <div class="grow">
                  <div class="title">${esc(invoice.number)}</div>
                  <div class="meta">${formatDate(invoice.issue_date)} • ${esc(statusOf(invoice))}</div>
                </div>
                <span class="amount ${statusClass(statusOf(invoice))}">${format(balanceOf(invoice) || totalsOf(invoice).total)}</span>
              </button>`
            )
            .join('')}</div>`
        : '<div class="empty"><h3>No invoices yet</h3><p>Create one for this client.</p></div>'
    }

    ${
      receipts.length
        ? `<div class="section-head"><h2>Receipts</h2><span class="sub">${receipts.length}</span></div>
           <div class="card tint">${receipts
             .slice()
             .reverse()
             .map((receipt) => {
               const payment = state.data.payments.find((candidate) => candidate.id === receipt.payment_id);
               return `<div class="receipt-row">
                 <div class="grow">
                   <div style="font-weight:650">${esc(receipt.receipt_number)}</div>
                   <div class="meta sub">${formatDate(receipt.issued_at)}</div>
                 </div>
                 <span class="amount">${format(payment?.amount_kobo || 0)}</span>
                 <button class="btn btn-sm btn-outline" data-act="open-receipt" data-id="${receipt.id}">View</button>
               </div>`;
             })
             .join('')}</div>`
        : ''
    }

    <div class="spacer"></div>
    <div class="btn-row">
      <button class="btn btn-quiet" data-act="edit-client" data-id="${client.id}">Edit</button>
      <button class="btn btn-danger" data-act="delete-client" data-id="${client.id}">Delete</button>
    </div>
  `);
}

// ---- screens: recurring ------------------------------------------------------------------

function renderRecurring() {
  const schedules = state.data.recurring.slice().sort((a, b) => a.next_run_date - b.next_run_date);
  appEl.className = 'app no-tabs';
  tabbarEl.hidden = true;
  fabEl.hidden = true;
  appEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="back" data-act="back" aria-label="Back">←</button>
        <h1>Recurring invoices</h1>
      </div>
      <p class="sub">InvoiceNaija generates these automatically when you open the app on or after their run date.</p>
      <div class="spacer"></div>
      ${
        schedules.length
          ? `<div class="list">${schedules
              .map((schedule) => {
                const client = clientOf(schedule.client_id);
                const amount = R.totals(schedule.items, schedule.discount_kobo, schedule.vat_enabled).total;
                return `<div class="list-item" style="align-items:flex-start;flex-direction:column;gap:8px">
                  <div class="row" style="width:100%">
                    <div class="grow">
                      <div class="title truncate">${esc(client?.name || 'Client')}</div>
                      <div class="meta">${esc(schedule.frequency)} • ${format(amount)} • next ${formatDate(schedule.next_run_date)}</div>
                      <div class="meta">${schedule.active ? 'Active' : 'Paused'}${schedule.auto_send ? ' • auto-notify owner' : ''}${schedule.runs ? ` • ${schedule.runs} run${schedule.runs === 1 ? '' : 's'}` : ''}</div>
                    </div>
                    <div class="switch ${schedule.active ? 'on' : ''}" data-act="toggle-recurring" data-id="${schedule.id}" role="switch" aria-checked="${schedule.active}" aria-label="Active"></div>
                  </div>
                  <div class="btn-row" style="width:100%">
                    <button class="btn btn-sm btn-outline" data-act="edit-recurring" data-id="${schedule.id}">Edit</button>
                    <button class="btn btn-sm btn-outline" data-act="run-recurring" data-id="${schedule.id}">Run now</button>
                    <button class="btn btn-sm btn-danger" data-act="delete-recurring" data-id="${schedule.id}">Delete</button>
                  </div>
                </div>`;
              })
              .join('')}</div>`
          : `<div class="empty"><h3>No recurring invoices</h3><p>Open any invoice and tap “Make recurring” to bill a client every week, month, quarter or year.</p><button class="btn btn-outline" data-act="tab" data-id="invoices">Go to invoices</button></div>`
      }
      <div class="spacer"></div>
      <div class="notice info">Scheduled jobs need a server. This build runs due invoices when the app opens, which covers a phone that is used weekly. For exact-time generation on a server, see docs/BUILD.md.</div>
      <div class="spacer"></div>
    </div>`;
}

function openRecurringSheet(invoiceId, recurringId) {
  if (!proUser()) {
    openPaywall('recurring');
    return;
  }
  const schedule = recurringId ? state.data.recurring.find((candidate) => candidate.id === recurringId) : null;
  const invoice = invoiceId ? invoiceOf(invoiceId) : null;
  const amount = schedule
    ? R.totals(schedule.items, schedule.discount_kobo, schedule.vat_enabled).total
    : R.totals(invoice.items, invoice.discount_kobo, invoice.vat_enabled).total;
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>${schedule ? 'Edit schedule' : 'Make recurring'}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <p class="sub">${esc(invoice?.number || '')} ${amount ? `• ${format(amount)} per run` : ''}</p>
    <div class="field">
      <label class="label" for="rec-frequency">Frequency</label>
      <select id="rec-frequency">
        ${R.FREQUENCIES.map((frequency) => `<option ${schedule?.frequency === frequency ? 'selected' : ''}>${frequency}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label class="label" for="rec-next">Next run date</label>
      <input id="rec-next" type="date" value="${R.isoDate(schedule?.next_run_date || R.advanceDate(Date.now(), 'Monthly'))}" />
    </div>
    <div class="field">
      <label class="label" for="rec-end">End date (optional)</label>
      <input id="rec-end" type="date" value="${schedule?.end_date ? R.isoDate(schedule.end_date) : ''}" />
    </div>
    <div class="switch-row" style="margin-top:10px">
      <div class="grow">
        <div style="font-weight:650">Notify me on each run</div>
        <div class="sub">One-tap share when a recurring invoice is generated</div>
      </div>
      <div class="switch ${schedule?.auto_send ? 'on' : ''}" id="rec-auto" data-act="toggle-simple" role="switch" aria-checked="${Boolean(schedule?.auto_send)}" aria-label="Notify me"></div>
    </div>
    <div class="spacer"></div>
    <button class="btn btn-primary" data-act="save-recurring" data-id="${invoiceId || ''}" data-recurring="${recurringId || ''}">Save schedule</button>
  `);
}

function saveRecurring(invoiceId, recurringId) {
  const frequency = document.getElementById('rec-frequency').value;
  const nextValue = document.getElementById('rec-next').value;
  const endValue = document.getElementById('rec-end').value;
  const autoSend = document.getElementById('rec-auto').classList.contains('on');
  const next = nextValue ? new Date(`${nextValue}T09:00:00`).getTime() : R.advanceDate(Date.now(), frequency);
  const end = endValue ? new Date(`${endValue}T23:59:59`).getTime() : null;

  if (recurringId) {
    const schedule = state.data.recurring.find((candidate) => candidate.id === recurringId);
    Object.assign(schedule, { frequency, next_run_date: next, end_date: end, auto_send: autoSend, active: true });
    save();
    closeModal();
    render();
    toast('Schedule updated');
    return;
  }
  const invoice = invoiceOf(invoiceId);
  S.makeRecurring(state.data, invoice, { frequency, next_run_date: next, end_date: end, auto_send: autoSend });
  save();
  closeModal();
  render();
  toast('Recurring schedule saved');
  renderRecurring();
}

// ---- screens: upgrade --------------------------------------------------------------------

function openPaywall(reason) {
  const messages = {
    limit: 'You have used all 3 free invoices this month. Upgrade to Pro for unlimited invoices, reminders, receipts and recurring billing.',
    receipts: 'Receipts are part of Pro. Upgrade to issue branded receipts for every payment.',
    reminders: 'Payment reminders are part of Pro. Upgrade to chase overdue invoices in one tap.',
    recurring: 'Recurring invoices are part of Pro. Upgrade to bill your clients automatically.',
    logo: 'Your logo and custom colours on invoices are part of Pro.',
    pdf: 'Unlock this invoice’s PDF with your logo for ₦200, or upgrade to Pro for every invoice.',
  };
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>InvoiceNaija Pro</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <p class="sub">${esc(messages[reason] || messages.limit)}</p>
    <div class="spacer"></div>
    <button class="btn btn-accent" data-act="upgrade">See plans</button>
    <div class="spacer" style="height:10px"></div>
    <button class="btn btn-outline" data-act="close-modal">Not now</button>
  `);
}

function renderUpgrade(invoiceId, options = {}) {
  const usage = R.canCreateInvoice(state.data);
  const pro = proUser();
  const testMode = Paystack.isTestMode();
  appEl.className = 'app no-tabs';
  tabbarEl.hidden = true;
  fabEl.hidden = true;
  appEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="back" data-act="back" aria-label="Back">←</button>
        <h1>Plans &amp; billing</h1>
      </div>
      ${options.reason === 'limit' ? '<div class="alert warn">Free plan: 3 invoices a month is used up. Existing invoices are still yours to view, share and get paid.</div>' : ''}

      <div class="card">
        <div class="row between">
          <div>
            <div class="label">Your plan</div>
            <div style="font-size:19px;font-weight:750;margin-top:2px">${pro ? 'Pro' : 'Free'}</div>
          </div>
          ${pro ? `<span class="pill pill-paid">Active</span>` : `<span class="pill pill-draft">Free</span>`}
        </div>
        <div class="usage">
          <div class="row between sub" style="font-size:12.5px">
            <span>Invoices this month</span>
            <span>${usage.used} of ${usage.limit ?? '∞'} used</span>
          </div>
          ${
            usage.limit
              ? `<div class="progress-track" style="margin-top:6px"><div class="progress-fill" style="width:${Math.min(100, (usage.used / usage.limit) * 100)}%"></div></div>`
              : ''
          }
        </div>
        ${pro ? `<div class="hint">Renews ${formatDate(state.data.plan.renews_at)} • ${esc(state.data.plan.billing || 'Monthly')}</div>` : ''}
      </div>

      <div class="spacer"></div>
      <div class="plan featured">
        <div class="row between"><h3>Pro — monthly</h3><span class="pill pill-sent">Popular</span></div>
        <div class="price">₦2,500 <span>/ month</span></div>
        <ul>
          <li>Unlimited invoices</li>
          <li>Logo &amp; custom colours</li>
          <li>Payment reminders + schedule</li>
          <li>Receipts for every payment</li>
          <li>Recurring invoices</li>
        </ul>
        <button class="btn btn-accent" data-act="buy" data-id="monthly">Upgrade monthly</button>
      </div>
      <div class="spacer"></div>
      <div class="plan">
        <h3>Pro — yearly</h3>
        <div class="price">₦20,000 <span>/ year</span> <span style="color:var(--green)">save ₦10,000</span></div>
        <ul><li>Everything in Pro monthly</li><li>Two months free</li></ul>
        <button class="btn btn-primary" data-act="buy" data-id="yearly">Upgrade yearly</button>
      </div>

      ${
        invoiceId
          ? `<div class="spacer"></div>
             <div class="card tint">
               <div class="row between"><div><div style="font-weight:700">Pay per invoice</div><div class="sub">Unlock the branded PDF for ${esc(invoiceOf(invoiceId)?.number || 'this invoice')}</div></div><div class="amount">₦200</div></div>
               <div class="spacer"></div>
               <button class="btn btn-outline" data-act="buy" data-id="invoice" data-invoice="${invoiceId}">Unlock this PDF</button>
             </div>`
          : ''
      }

      <div class="spacer"></div>
      ${
        testMode
          ? `<div class="notice test"><b>Test mode.</b> No Paystack public key is configured, so checkout cannot take real money. Tapping upgrade activates Pro on this device so the flow can be assessed end to end. Add your <code>pk_test_…</code> key in <code>www/config.js</code> (or a build secret) to go live; see docs/BUILD.md.</div>`
          : `<div class="notice ok">Paystack is configured. Payments go through checkout and are verified by your server before Pro is switched on.</div>`
      }
      ${pro ? `<div class="spacer"></div><button class="btn btn-quiet" data-act="downgrade">Switch back to Free</button>` : ''}
      <div class="spacer"></div>
      <p class="hint">Free plan: 3 invoices a month, basic template. Viewing, sharing and getting paid on existing invoices is never blocked.</p>
    </div>`;
}

async function buy(kind, invoiceId) {
  const amount = kind === 'monthly' ? R.PRICES.pro_monthly : kind === 'yearly' ? R.PRICES.pro_yearly : R.PRICES.per_invoice;
  const label = kind === 'monthly' ? 'Pro monthly' : kind === 'yearly' ? 'Pro yearly' : 'Invoice PDF unlock';
  const reference = Paystack.newReference(kind === 'invoice' ? 'PDF' : 'SUB');

  if (Paystack.isTestMode()) {
    openModal(`
      <div class="grab"></div>
      <div class="sheet-head"><h2>Test mode checkout</h2></div>
      <p class="sub">No Paystack key is configured. This activates "${esc(label)}" (${format(amount)}) on this device only, so you can assess the upgrade flow. No money moves.</p>
      <div class="spacer"></div>
      <button class="btn btn-accent" data-act="test-activate" data-id="${kind}" data-invoice="${invoiceId || ''}">Activate in test mode</button>
      <div class="spacer" style="height:10px"></div>
      <button class="btn btn-outline" data-act="close-modal">Cancel</button>
    `);
    return;
  }

  try {
    toast('Opening Paystack…');
    const result = await Paystack.checkout({
      email: state.account.email || `${state.account.phone}@invoicenaija.local`,
      amountKobo: amount,
      reference,
      metadata: { kind, invoiceId: invoiceId || '', business: state.data.business.business_name },
    });
    if (Paystack.hasVerifyEndpoint()) {
      const verification = await Paystack.verifyOnServer(result.reference, amount);
      if (!verification.verified) {
        toast(`Payment not verified (${verification.reason}). Plan not changed.`, 'error');
        return;
      }
    }
    applyPurchase(kind, invoiceId, result.reference);
    toast(`${label} activated`);
  } catch (error) {
    if (error.message === 'CANCELLED') toast('Checkout closed');
    else toast(error.message || 'Could not open checkout', 'error');
  }
}

function applyPurchase(kind, invoiceId, reference = 'TEST') {
  if (kind === 'invoice' && invoiceId) {
    const invoice = invoiceOf(invoiceId);
    if (invoice) invoice.pdf_unlocked = true;
    state.data.plan.receipts = [...(state.data.plan.receipts || []), { kind, amount: R.PRICES.per_invoice, at: Date.now(), reference }];
  } else {
    S.upgradePlan(state.data, { tier: 'Pro', billing: kind === 'yearly' ? 'Yearly' : 'Monthly' });
    state.data.plan.last_reference = reference;
    state.data.plan.receipts = [...(state.data.plan.receipts || []), { kind, at: Date.now(), reference }];
  }
  save();
  closeModal();
  render();
}

// ---- screens: settings -------------------------------------------------------------------

function renderSettings() {
  const business = state.data.business;
  const plan = state.data.plan;
  const pro = proUser();
  const usage = R.canCreateInvoice(state.data);
  const schedule = { ...R.DEFAULT_SCHEDULE, ...(business.reminder_schedule || {}) };
  appEl.className = 'app';
  appEl.innerHTML = `
    <div class="screen">
      <h1 class="page">Settings</h1>
      <p class="sub">Business details, reminders, plan and data.</p>

      <div class="section-head"><h2>Business profile</h2></div>
      <div class="field">
        <label class="label" for="set-name">Business name</label>
        <input id="set-name" value="${esc(business.business_name)}" />
      </div>
      <div class="field">
        <label class="label" for="set-phone">Phone</label>
        <input id="set-phone" inputmode="tel" value="${esc(business.phone)}" />
      </div>
      <div class="field">
        <label class="label" for="set-whatsapp">WhatsApp</label>
        <input id="set-whatsapp" inputmode="tel" value="${esc(business.whatsapp)}" />
      </div>
      <div class="field">
        <label class="label" for="set-address">Address</label>
        <input id="set-address" value="${esc(business.address)}" />
      </div>
      <div class="field">
        <label class="label">Logo ${pro ? '' : '(Pro)'}</label>
        <div class="row">
          ${business.logo_url ? `<img src="${esc(business.logo_url)}" alt="logo" style="width:52px;height:52px;border-radius:12px;object-fit:cover;border:1px solid var(--line)" />` : '<div class="avatar" style="border-radius:12px">₦</div>'}
          <label class="btn btn-sm btn-outline" style="flex:1;cursor:pointer">
            ${business.logo_url ? 'Change logo' : 'Upload logo'}
            <input id="settings-logo" type="file" accept="image/*" hidden />
          </label>
          ${business.logo_url ? '<button class="btn btn-sm btn-quiet" data-act="remove-logo">Remove</button>' : ''}
        </div>
        ${pro ? '' : '<div class="hint">Logo and custom colours are part of Pro. Upload is available in test mode after upgrading.</div>'}
      </div>
      <div class="field">
        <label class="label">Invoice accent colour ${pro ? '' : '(Pro)'}</label>
        <input id="settings-color" type="color" value="${esc(business.brand_color || '#0B6E4F')}" style="height:50px;padding:6px" />
      </div>

      <div class="spacer"></div>
      <button class="btn btn-primary" data-act="settings-save">Save changes</button>

      <div class="section-head"><h2>Bank details</h2></div>
      <div class="field">
        <label class="label" for="set-bank">Bank name</label>
        <input id="set-bank" value="${esc(business.bank_name)}" placeholder="Guaranty Trust Bank" />
      </div>
      <div class="field">
        <label class="label" for="set-account-number">Account number</label>
        <input id="set-account-number" inputmode="numeric" maxlength="10" value="${esc(business.account_number)}" />
        <div class="hint">Must be exactly 10 digits.</div>
      </div>
      <div class="field">
        <label class="label" for="set-account-name">Account name</label>
        <input id="set-account-name" value="${esc(business.account_name)}" />
      </div>

      <div class="section-head"><h2>Invoice settings</h2></div>
      <div class="field">
        <label class="label" for="set-prefix">Invoice prefix</label>
        <input id="set-prefix" value="${esc(business.invoice_prefix)}" maxlength="8" />
        <div class="hint">Next number: ${esc(R.nextNumber(business.invoice_prefix, state.data.invoices.map((invoice) => invoice.number)))}</div>
      </div>
      <div class="switch-row" style="margin-top:12px">
        <div class="grow"><div style="font-weight:650">VAT on by default</div><div class="sub">7.5% added to new invoices</div></div>
        <div class="switch ${business.vat_default ? 'on' : ''}" data-act="toggle-flag" data-flag="vat_default" role="switch" aria-checked="${business.vat_default}" aria-label="VAT on by default"></div>
      </div>

      <div class="section-head"><h2>Payment reminders</h2></div>
      <div class="field">
        <label class="label" for="set-reminder">Reminder template</label>
        <textarea id="set-reminder" style="min-height:150px">${esc(business.reminder_template)}</textarea>
        <div class="hint">Placeholders: {client_name} {invoice_number} {amount_due} {due_date} {business_name} {pay_link}</div>
      </div>
      <div class="label" style="margin-top:14px">When to nudge</div>
      <div class="switch-list" style="margin-top:8px">
        ${R.REMINDER_OFFSETS.map(
          (offset) => `
          <div class="switch-row">
            <div class="grow"><div style="font-weight:600">${esc(offset.label)}</div></div>
            <div class="switch ${schedule[offset.key] ? 'on' : ''}" data-act="toggle-schedule" data-flag="${offset.key}" role="switch" aria-checked="${Boolean(schedule[offset.key])}" aria-label="${esc(offset.label)}"></div>
          </div>`
        ).join('')}
      </div>
      <div class="spacer"></div>
      <button class="btn btn-outline" data-act="preview-reminder">Preview reminder message</button>

      <div class="section-head"><h2>Notifications</h2></div>
      <div class="card">
        <div class="row between">
          <div class="grow"><div style="font-weight:650">Follow-up alerts</div><div class="sub">In-app alerts when invoices need chasing</div></div>
          <span class="pill ${'Notification' in window && Notification.permission === 'granted' ? 'pill-paid' : 'pill-draft'}">${'Notification' in window ? Notification.permission : 'unsupported'}</span>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-outline" data-act="enable-notifications">Turn on system notifications</button>
        <div class="hint">Push notifications that arrive while the app is closed need a server. On this build you get in-app alerts and system notifications while the app is open.</div>
      </div>

      <div class="section-head"><h2>Plan</h2></div>
      <div class="card">
        <div class="row between">
          <div><div class="label">Current plan</div><div style="font-size:18px;font-weight:750">${pro ? 'Pro' : 'Free'}</div></div>
          <span class="pill ${pro ? 'pill-paid' : 'pill-draft'}">${pro ? esc(plan.billing || 'Monthly') : `${usage.used}/${usage.limit} invoices`}</span>
        </div>
        <div class="spacer"></div>
        <button class="btn ${pro ? 'btn-outline' : 'btn-accent'}" data-act="upgrade">${pro ? 'Manage plan' : 'Upgrade to Pro'}</button>
      </div>

      <div class="section-head"><h2>Automation</h2></div>
      <button class="btn btn-outline" data-act="open-recurring">Recurring invoices (${state.data.recurring.length})</button>
      <div class="switch-row" style="margin-top:10px">
        <div class="grow"><div style="font-weight:650">WhatsApp Business API hook</div><div class="sub">${cfg().whatsappApiHook ? 'Configured' : 'Off by default'}</div></div>
        <div class="switch ${business.whatsapp_api_enabled ? 'on' : ''}" data-act="toggle-flag" data-flag="whatsapp_api_enabled" role="switch" aria-checked="${business.whatsapp_api_enabled}" aria-label="WhatsApp API hook"></div>
      </div>
      <div class="hint">When enabled and an endpoint is configured, reminders are also POSTed to your WhatsApp Business API. Until then everything goes through wa.me.</div>

      <div class="section-head"><h2>Your data</h2></div>
      ${S.hasSampleData(state.data) ? `<button class="btn btn-outline" data-act="remove-samples">Remove sample data</button><div class="spacer" style="height:10px"></div>` : ''}
      <button class="btn btn-outline" data-act="delete-all">Delete everything</button>
      <div class="spacer" style="height:10px"></div>
      <button class="btn btn-quiet" data-act="sign-out">Sign out</button>

      <div class="section-head"><h2>About</h2></div>
      <div class="card">
        <div class="row between"><span class="sub">Version</span><b>${esc(VERSION())}</b></div>
        <div class="row between" style="margin-top:8px"><span class="sub">Works offline</span><b>Yes</b></div>
        <div class="row between" style="margin-top:8px"><span class="sub">Currency</span><b>Naira (₦)</b></div>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-outline" data-act="share-app">Share InvoiceNaija</button>
      <div class="spacer"></div>
      <p class="hint">InvoiceNaija stores invoices on this device. Data stays with you, and nothing is uploaded without your action.</p>
      <div class="spacer"></div>
    </div>`;
}

function saveSettings() {
  const value = (id) => document.getElementById(id)?.value?.trim() ?? '';
  const errorTarget = document.getElementById('set-account-number');
  const account = R.normalizeAccountNumber(value('set-account-number'));
  if (!account.ok && value('set-account-number')) {
    errorTarget.setAttribute('aria-invalid', 'true');
    toast(account.message, 'error');
    return;
  }
  errorTarget.removeAttribute('aria-invalid');
  const prefix = value('set-prefix') || 'INV';
  Object.assign(state.data.business, {
    business_name: value('set-name') || state.data.business.business_name,
    phone: value('set-phone'),
    whatsapp: value('set-whatsapp'),
    address: value('set-address'),
    bank_name: value('set-bank'),
    account_number: account.value,
    account_name: value('set-account-name'),
    invoice_prefix: prefix,
    reminder_template: value('set-reminder') || R.DEFAULT_REMINDER_TEMPLATE,
  });
  save();
  toast('Settings saved');
  render();
}

function previewReminder() {
  const invoice = state.data.invoices.find((candidate) => balanceOf(candidate) > 0) || state.data.invoices[0];
  const client = invoice ? clientOf(invoice.client_id) : null;
  const message = invoice
    ? R.reminderMessage(state.data.business.reminder_template, {
        business: state.data.business,
        client,
        invoice,
        balance: balanceOf(invoice),
      })
    : R.reminderMessage(state.data.business.reminder_template, {
        business: state.data.business,
        client: { name: 'Ada' },
        invoice: { number: 'INV-001', due_date: Date.now() + 3 * 86400000 },
        balance: 2500000,
      });
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>Reminder preview</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <div class="card tint" style="white-space:pre-line">${esc(message)}</div>
    <div class="spacer"></div>
    <button class="btn btn-primary" data-act="close-modal">Done</button>
  `);
}

function openNotifications() {
  state.data.notifications.forEach((notification) => {
    notification.read = true;
  });
  save();
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>Notifications</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    ${
      state.data.notifications.length
        ? state.data.notifications
            .slice(0, 12)
            .map(
              (notification) => `<div class="receipt-row">
                <div class="grow">
                  <div style="font-weight:650">${esc(notification.title)}</div>
                  <div class="sub">${esc(notification.body)}</div>
                </div>
                <div class="meta sub">${formatDate(notification.at)}</div>
              </div>`
            )
            .join('')
        : '<div class="empty"><h3>All clear</h3><p>No alerts right now.</p></div>'
    }
    <div class="spacer"></div>
    <button class="btn btn-outline" data-act="enable-notifications">Turn on system notifications</button>
  `);
}

// ---- documents and sharing ---------------------------------------------------------------

async function generatePdf(html, filename, mode) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;background:#fff';
  holder.innerHTML = html;
  document.body.appendChild(holder);
  try {
    const { pdf } = await documentToPdf(holder.querySelector('.doc'));
    return await deliverPdf(pdf, filename, { share: mode === 'share', title: filename.replace('.pdf', '') });
  } finally {
    holder.remove();
  }
}

function invoiceHtml(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  return invoiceDocHtml({
    business: state.data.business,
    client: clientOf(invoice.client_id),
    invoice,
    payments: state.data.payments,
    brandable: R.canBrandPdf(state.data, invoice),
  });
}

function receiptHtml(receiptId) {
  const receipt = state.data.receipts.find((candidate) => candidate.id === receiptId);
  const invoice = invoiceOf(receipt.invoice_id);
  const payment = state.data.payments.find((candidate) => candidate.id === receipt.payment_id);
  return receiptDocHtml({
    business: state.data.business,
    client: clientOf(invoice?.client_id),
    invoice,
    payment,
    receipt,
    payments: state.data.payments,
    brandable: R.canBrandPdf(state.data, invoice),
  });
}

async function downloadInvoice(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const filename = invoiceFilename(state.data.business, clientOf(invoice.client_id), invoice);
  toast('Building PDF…');
  try {
    await generatePdf(invoiceHtml(invoiceId), filename, 'download');
    toast('PDF saved');
  } catch (error) {
    toast('Could not build the PDF', 'error');
  }
}

async function shareInvoice(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const client = clientOf(invoice.client_id);
  const filename = invoiceFilename(state.data.business, client, invoice);
  const message = R.invoiceMessage(state.data.business, client, invoice, state.data.payments);
  toast('Preparing invoice…');
  let shared = false;
  try {
    const result = await generatePdf(invoiceHtml(invoiceId), filename, 'share');
    shared = Boolean(result?.shared);
  } catch (error) {
    toast('Could not build the PDF', 'error');
    return;
  }
  if (invoice.status === R.STATUS.DRAFT) {
    invoice.status = R.STATUS.SENT;
    save();
  }
  const link = R.waLink(client?.phone, message);
  if (!shared) {
    // On the web the PDF is downloaded; WhatsApp cannot take a file from a link, so say so plainly.
    toast('PDF saved — attach it in the WhatsApp chat that opens');
    if (link) openExternal(link);
  }
  render();
}

async function emailInvoice(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const client = clientOf(invoice.client_id);
  const filename = invoiceFilename(state.data.business, client, invoice);
  const message = R.invoiceMessage(state.data.business, client, invoice, state.data.payments);
  try {
    const result = await generatePdf(invoiceHtml(invoiceId), filename, 'share');
    if (!result?.shared) toast('PDF saved — attach it to the email');
  } catch (error) {
    toast('Could not build the PDF', 'error');
  }
  const subject = `Invoice ${invoice.number} from ${state.data.business.business_name || 'InvoiceNaija'}`;
  const mailto = `mailto:${encodeURIComponent(client?.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
  setTimeout(() => {
    window.location.href = mailto;
  }, 700);
}

async function downloadReceipt(receiptId) {
  const receipt = state.data.receipts.find((candidate) => candidate.id === receiptId);
  const invoice = invoiceOf(receipt.invoice_id);
  const filename = receiptFilename(state.data.business, clientOf(invoice?.client_id), receipt);
  toast('Building receipt…');
  try {
    await generatePdf(receiptHtml(receiptId), filename, 'download');
    toast('Receipt saved');
  } catch (error) {
    toast('Could not build the receipt', 'error');
  }
}

async function shareReceipt(receiptId) {
  const receipt = state.data.receipts.find((candidate) => candidate.id === receiptId);
  const invoice = invoiceOf(receipt.invoice_id);
  const client = clientOf(invoice?.client_id);
  const payment = state.data.payments.find((candidate) => candidate.id === receipt.payment_id);
  const filename = receiptFilename(state.data.business, client, receipt);
  const message = `Hello ${client?.name || 'there'}, thank you for your payment of ${format(payment?.amount_kobo || 0)} on invoice ${invoice?.number}. Receipt ${receipt.receipt_number} is attached.`;
  try {
    const result = await generatePdf(receiptHtml(receiptId), filename, 'share');
    if (!result?.shared) {
      toast('Receipt saved — attach it in the WhatsApp chat that opens');
      const link = R.waLink(client?.phone, message);
      if (link) openExternal(link);
    }
  } catch (error) {
    toast('Could not build the receipt', 'error');
  }
}

async function emailReceipt(receiptId) {
  const receipt = state.data.receipts.find((candidate) => candidate.id === receiptId);
  const invoice = invoiceOf(receipt.invoice_id);
  const client = clientOf(invoice?.client_id);
  const payment = state.data.payments.find((candidate) => candidate.id === receipt.payment_id);
  const filename = receiptFilename(state.data.business, client, receipt);
  try {
    const result = await generatePdf(receiptHtml(receiptId), filename, 'share');
    if (!result?.shared) toast('Receipt saved — attach it to the email');
  } catch (error) {
    toast('Could not build the receipt', 'error');
  }
  const subject = `Receipt ${receipt.receipt_number} from ${state.data.business.business_name || 'InvoiceNaija'}`;
  const body = `Hello ${client?.name || 'there'},\n\nThank you for your payment of ${format(payment?.amount_kobo || 0)} on invoice ${invoice?.number}.\n\nReceipt: ${receipt.receipt_number}\nDate: ${formatDate(receipt.issued_at)}\n\n${state.data.business.business_name}`;
  setTimeout(() => {
    window.location.href = `mailto:${encodeURIComponent(client?.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }, 700);
}

// ---- invoice actions ---------------------------------------------------------------------

function openInvoiceMenu(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const balance = balanceOf(invoice);
  openModal(`
    <div class="grab"></div>
    <div class="sheet-head"><h2>${esc(invoice.number)}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <p class="sub">${esc(clientOf(invoice.client_id)?.name || 'Client')} • ${format(totalsOf(invoice).total)}</p>
    <div class="stack" style="margin-top:12px">
      ${balance > 0 ? `<button class="btn btn-primary" data-act="record-payment" data-id="${invoice.id}">Record payment (${format(balance)} due)</button>` : ''}
      ${balance > 0 ? `<button class="btn btn-outline" data-act="mark-paid-full" data-id="${invoice.id}">Mark fully paid</button>` : ''}
      ${invoice.status === R.STATUS.DRAFT ? `<button class="btn btn-outline" data-act="mark-sent" data-id="${invoice.id}">Mark as sent</button>` : ''}
      <button class="btn btn-outline" data-act="make-recurring" data-id="${invoice.id}">Make recurring</button>
      <button class="btn btn-outline" data-act="duplicate-invoice" data-id="${invoice.id}">Duplicate</button>
      <button class="btn btn-danger" data-act="delete-invoice" data-id="${invoice.id}">Delete invoice</button>
    </div>
  `);
}

function quickMarkPaid(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const balance = balanceOf(invoice);
  if (balance <= 0) return;
  const { receipt } = S.recordPayment(state.data, invoice, {
    amount_kobo: balance,
    payment_date: Date.now(),
    method: 'Other',
    reference: '',
    note: 'Marked paid from the invoice list',
  });
  save();
  const swipeEl = document.querySelector(`[data-swipe="${invoiceId}"]`);
  swipeEl?.classList.remove('open');
  render();
  openReceiptSheet(receipt.id);
  toast(`${format(balance)} recorded • ${receipt.receipt_number}`);
}

function markFullyPaid(invoiceId) {
  const invoice = invoiceOf(invoiceId);
  const balance = balanceOf(invoice);
  if (balance <= 0) {
    toast('Already fully paid');
    return;
  }
  const { receipt } = S.recordPayment(state.data, invoice, {
    amount_kobo: balance,
    payment_date: Date.now(),
    method: 'Cash',
    reference: '',
    note: 'Marked fully paid',
  });
  save();
  closeModal();
  render();
  openReceiptSheet(receipt.id);
}

function runRecurringNow(recurringId) {
  const schedule = recurringId ? state.data.recurring.find((candidate) => candidate.id === recurringId) : null;
  if (schedule) schedule.next_run_date = Date.now();
  const created = S.runDueRecurring(state.data, Date.now() + 1000);
  save();
  if (!created.length) {
    toast('Nothing was due');
  } else {
    const first = created[0];
    toast(`${created.length} invoice${created.length === 1 ? '' : 's'} generated`);
    pushNotification('Recurring invoice created', `${first.invoice.number} for ${first.client?.name || 'client'} is ready to share.`);
    go('preview', { invoiceId: first.invoice.id });
    return;
  }
  render();
}

// ---- event handling ----------------------------------------------------------------------

async function onClick(event) {
  const backdrop = event.target.classList?.contains('modal-backdrop');
  const el = event.target.closest('[data-act]');
  if (!el) {
    if (backdrop) closeModal();
    return;
  }
  const act = el.dataset.act;
  const id = el.dataset.id;
  const idx = Number(el.dataset.idx);

  switch (act) {
    case 'close-modal':
      closeModal();
      break;
    case 'back':
      back();
      break;
    case 'tab':
      setTab(id);
      break;
    case 'auth-signup':
      await doAuth('signup');
      break;
    case 'auth-signin':
      await doAuth('signin');
      break;
    case 'auth-google':
      doGoogle();
      break;
    case 'onboard-save':
      saveOnboarding();
      break;

    case 'new-invoice':
      openEditor(null);
      break;
    case 'new-invoice-for':
      closeModal();
      state.draft = null;
      openEditor(null);
      state.draft.client_id = id;
      render();
      break;
    case 'filter':
      state.filter = id;
      render();
      break;
    case 'filter-invoices':
      state.filter = id;
      setTab('invoices');
      break;
    case 'open-invoice': {
      const swipe = el.closest('.swipe');
      if (swipe?.classList.contains('open')) {
        swipe.classList.remove('open');
        break;
      }
      go('preview', { invoiceId: id });
      break;
    }
    case 'edit-invoice':
      closeModal();
      openEditor(id);
      break;
    case 'invoice-menu':
      openInvoiceMenu(id);
      break;
    case 'quick-paid':
      quickMarkPaid(id);
      break;
    case 'mark-paid-full':
      markFullyPaid(id);
      break;
    case 'mark-sent': {
      const invoice = invoiceOf(id);
      invoice.status = R.STATUS.SENT;
      save();
      closeModal();
      render();
      toast('Marked as sent');
      break;
    }
    case 'duplicate-invoice': {
      const copy = S.duplicateInvoice(state.data, invoiceOf(id));
      save();
      closeModal();
      toast(`${copy.number} created`);
      go('preview', { invoiceId: copy.id });
      break;
    }
    case 'delete-invoice': {
      const invoice = invoiceOf(id);
      closeModal();
      openModal(`
        <div class="grab"></div>
        <div class="sheet-head"><h2>Delete ${esc(invoice.number)}?</h2></div>
        <p class="sub">This removes the invoice, its payments and receipts from this device. It cannot be undone.</p>
        <div class="spacer"></div>
        <div class="btn-row">
          <button class="btn btn-outline" data-act="close-modal">Keep</button>
          <button class="btn btn-danger" data-act="confirm-delete-invoice" data-id="${id}" style="background:var(--red);color:#fff">Delete</button>
        </div>
      `);
      break;
    }
    case 'confirm-delete-invoice': {
      state.data.invoices = state.data.invoices.filter((invoice) => invoice.id !== id);
      state.data.payments = state.data.payments.filter((payment) => payment.invoice_id !== id);
      state.data.receipts = state.data.receipts.filter((receipt) => receipt.invoice_id !== id);
      save();
      closeModal();
      setTab('invoices');
      toast('Invoice deleted');
      break;
    }

    case 'add-item':
      syncEditorFromDom();
      state.draft.items.push({ description: '', qty: 1, unit_price: 0 });
      render();
      break;
    case 'remove-item':
      syncEditorFromDom();
      state.draft.items.splice(idx, 1);
      if (!state.draft.items.length) state.draft.items.push({ description: '', qty: 1, unit_price: 0 });
      render();
      break;
    case 'toggle-vat':
      syncEditorFromDom();
      state.draft.vat_enabled = !state.draft.vat_enabled;
      el.classList.toggle('on', state.draft.vat_enabled);
      el.setAttribute('aria-checked', String(state.draft.vat_enabled));
      updateEditorNumbers();
      break;
    case 'editor-save':
      saveEditor(id === 'draft');
      break;

    case 'record-payment':
      closeModal();
      openPaymentSheet(id);
      break;
    case 'save-payment':
      savePayment(id);
      break;
    case 'open-receipt':
      openReceiptSheet(id);
      break;
    case 'share-invoice':
      await shareInvoice(id);
      break;
    case 'download-invoice':
      await downloadInvoice(id);
      break;
    case 'email-invoice':
      await emailInvoice(id);
      break;
    case 'share-receipt':
      await shareReceipt(id);
      break;
    case 'download-receipt':
      await downloadReceipt(id);
      break;
    case 'email-receipt':
      await emailReceipt(id);
      break;

    case 'remind':
      openReminderSheet(id);
      break;
    case 'send-reminder-whatsapp':
      sendReminderWhatsApp(id);
      break;
    case 'copy-reminder': {
      const text = document.getElementById('reminder-text')?.value || '';
      try {
        await navigator.clipboard.writeText(text);
        toast('Message copied');
      } catch (error) {
        toast('Could not copy on this device', 'error');
      }
      break;
    }

    case 'make-recurring':
      closeModal();
      openRecurringSheet(id, null);
      break;
    case 'edit-recurring':
      openRecurringSheet(null, id);
      break;
    case 'save-recurring':
      saveRecurring(el.dataset.id || null, el.dataset.recurring || null);
      break;
    case 'toggle-recurring': {
      const schedule = state.data.recurring.find((candidate) => candidate.id === id);
      schedule.active = !schedule.active;
      save();
      render();
      toast(schedule.active ? 'Schedule resumed' : 'Schedule paused');
      break;
    }
    case 'run-recurring':
      runRecurringNow(id);
      break;
    case 'delete-recurring': {
      const schedule = state.data.recurring.find((candidate) => candidate.id === id);
      openModal(`
        <div class="grab"></div>
        <div class="sheet-head"><h2>Delete schedule?</h2></div>
        <p class="sub">${esc(clientOf(schedule.client_id)?.name || 'Client')} • ${esc(schedule.frequency)}. Invoices already generated are kept.</p>
        <div class="spacer"></div>
        <div class="btn-row">
          <button class="btn btn-outline" data-act="close-modal">Keep</button>
          <button class="btn btn-danger" data-act="confirm-delete-recurring" data-id="${id}" style="background:var(--red);color:#fff">Delete</button>
        </div>
      `);
      break;
    }
    case 'confirm-delete-recurring':
      state.data.recurring = state.data.recurring.filter((schedule) => schedule.id !== id);
      save();
      closeModal();
      render();
      toast('Schedule deleted');
      break;

    case 'add-client':
      openClientForm(null);
      break;
    case 'save-client':
      saveClient(id || null);
      break;
    case 'open-client':
      openClientSheet(id);
      break;
    case 'edit-client':
      closeModal();
      openClientForm(id);
      break;
    case 'delete-client': {
      const client = clientOf(id);
      const hasInvoices = state.data.invoices.some((invoice) => invoice.client_id === id);
      if (hasInvoices) {
        toast('This client has invoices. Delete those first.', 'error');
        break;
      }
      closeModal();
      openModal(`
        <div class="grab"></div>
        <div class="sheet-head"><h2>Delete ${esc(client.name)}?</h2></div>
        <p class="sub">This cannot be undone.</p>
        <div class="spacer"></div>
        <div class="btn-row">
          <button class="btn btn-outline" data-act="close-modal">Keep</button>
          <button class="btn btn-danger" data-act="confirm-delete-client" data-id="${id}" style="background:var(--red);color:#fff">Delete</button>
        </div>
      `);
      break;
    }
    case 'confirm-delete-client':
      state.data.clients = state.data.clients.filter((client) => client.id !== id);
      save();
      closeModal();
      render();
      toast('Client deleted');
      break;
    case 'call-client': {
      const client = clientOf(id);
      window.location.href = `tel:${(client.phone || '').replace(/[^\d+]/g, '')}`;
      break;
    }
    case 'whatsapp-client': {
      const client = clientOf(id);
      const link = R.waLink(client.phone, `Hello ${client.name},`);
      if (link) openExternal(link);
      else toast('No phone number saved', 'error');
      break;
    }

    case 'upgrade':
      closeModal();
      go('upgrade', { invoiceId: state.screen.invoiceId || null });
      break;
    case 'unlock-pdf':
      go('upgrade', { invoiceId: id });
      break;
    case 'buy':
      await buy(id, el.dataset.invoice);
      break;
    case 'test-activate':
      applyPurchase(id, el.dataset.invoice || null);
      toast('Pro activated in test mode');
      break;
    case 'downgrade':
      state.data.plan = { ...state.data.plan, tier: 'Free', status: 'inactive', renews_at: null };
      save();
      render();
      toast('Back on the Free plan');
      break;

    case 'notifications':
      openNotifications();
      break;
    case 'enable-notifications':
      await askNotificationPermission();
      render();
      break;
    case 'toggle-flag': {
      const flag = el.dataset.flag;
      if (flag === 'logo' || flag === 'brand_color') break;
      state.data.business[flag] = !state.data.business[flag];
      save();
      render();
      break;
    }
    case 'toggle-schedule': {
      const key = el.dataset.flag;
      const schedule = { ...R.DEFAULT_SCHEDULE, ...(state.data.business.reminder_schedule || {}) };
      schedule[key] = !schedule[key];
      state.data.business.reminder_schedule = schedule;
      save();
      render();
      break;
    }
    case 'toggle-simple':
      el.classList.toggle('on');
      el.setAttribute('aria-checked', String(el.classList.contains('on')));
      break;
    case 'preview-reminder':
      previewReminder();
      break;
    case 'settings-save':
      saveSettings();
      break;
    case 'remove-logo':
      state.data.business.logo_url = '';
      save();
      render();
      toast('Logo removed');
      break;
    case 'remove-samples':
      S.removeSampleData(state.data);
      save();
      render();
      toast('Sample data removed');
      break;
    case 'delete-all':
      openModal(`
        <div class="grab"></div>
        <div class="sheet-head"><h2>Delete everything?</h2></div>
        <p class="sub">All invoices, payments, receipts, clients and business details will be erased from this device.</p>
        <div class="spacer"></div>
        <div class="btn-row">
          <button class="btn btn-outline" data-act="close-modal">Cancel</button>
          <button class="btn btn-danger" data-act="confirm-delete-all" style="background:var(--red);color:#fff">Delete everything</button>
        </div>
      `);
      break;
    case 'confirm-delete-all':
      S.wipeData(state.account.id);
      state.data = S.loadData(state.account.id);
      closeModal();
      render();
      toast('All data deleted');
      break;
    case 'sign-out':
      S.auth.signOut();
      state.account = null;
      state.data = null;
      state.history = [];
      state.screen = { name: 'dashboard' };
      render();
      break;
    case 'share-app': {
      const text = 'I invoice my clients with InvoiceNaija — professional invoices in 30 seconds.';
      if (navigator.share) {
        navigator.share({ title: 'InvoiceNaija', text }).catch(() => {});
      } else {
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied to clipboard');
        } catch (error) {
          toast(text);
        }
      }
      break;
    }
    case 'open-recurring':
      go('recurring');
      break;
    default:
      break;
  }
}

function onInput(event) {
  const input = event.target;
  const field = input.dataset?.field;
  if (!field) return;

  if (field === 'search') {
    state.query = input.value;
    const position = input.selectionStart;
    render();
    const restored = document.getElementById('invoice-search');
    if (restored) {
      restored.focus();
      restored.setSelectionRange(position, position);
    }
    return;
  }
  if (field.startsWith('item-') || field === 'discount' || field === 'notes') {
    syncEditorFromDom();
    updateEditorNumbers();
  }
}

function onChange(event) {
  const input = event.target;

  if (input.id === 'settings-logo') {
    const file = input.files?.[0];
    if (!file) return;
    if (!proUser()) {
      openPaywall('logo');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        const size = Math.min(320, Math.max(image.width, image.height));
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        const ratio = Math.min(size / image.width, size / image.height);
        const width = image.width * ratio;
        const height = image.height * ratio;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, size, size);
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        state.data.business.logo_url = canvas.toDataURL('image/png', 0.9);
        save();
        render();
        toast('Logo updated');
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
    return;
  }

  if (input.id === 'settings-color') {
    if (!proUser()) {
      openPaywall('logo');
      input.value = state.data.business.brand_color || '#0B6E4F';
      return;
    }
    state.data.business.brand_color = input.value;
    save();
    toast('Colour saved');
    return;
  }

  const field = input.dataset?.field;
  if (field === 'client') {
    if (input.value === '__new') {
      openClientForm(null);
      return;
    }
    syncEditorFromDom();
    state.draft.client_id = input.value;
    return;
  }
  if (field === 'due') {
    syncEditorFromDom();
    state.draft.due_date = input.value ? new Date(`${input.value}T12:00:00`).getTime() : state.draft.due_date;
    updateEditorNumbers();
  }
}

function onKeydown(event) {
  if (event.key !== 'Enter') return;
  const active = document.activeElement;
  if (active?.id === 'auth-pin') doAuth('signin');
  if (active?.id === 'auth-phone') document.getElementById('auth-pin')?.focus();
}

// ---- swipe -------------------------------------------------------------------------------

function attachSwipe() {
  document.querySelectorAll('[data-swipe]').forEach((container) => {
    const inner = container.querySelector('.list-item');
    if (!inner || inner.dataset.swipeBound) return;
    inner.dataset.swipeBound = '1';
    let startX = 0;
    let delta = 0;
    let tracking = false;

    inner.addEventListener('pointerdown', (event) => {
      tracking = true;
      startX = event.clientX;
      delta = 0;
      inner.style.transition = 'none';
    });
    inner.addEventListener('pointermove', (event) => {
      if (!tracking) return;
      delta = event.clientX - startX;
      if (delta < 0) inner.style.transform = `translateX(${Math.max(-130, delta)}px)`;
    });
    const finish = () => {
      if (!tracking) return;
      tracking = false;
      inner.style.transition = '';
      inner.style.transform = '';
      if (delta < -60) container.classList.add('open');
      else container.classList.remove('open');
      delta = 0;
    };
    inner.addEventListener('pointerup', finish);
    inner.addEventListener('pointercancel', finish);
    inner.addEventListener('pointerleave', finish);
  });
}

// ---- data loading and boot ---------------------------------------------------------------

function loadAccount() {
  state.data = S.loadData(state.account.id);
  if (state.data.business.business_name) S.seedSampleData(state.data);
  const created = S.runDueRecurring(state.data);
  created.forEach((entry) => {
    S.notify(
      state.data,
      'Recurring invoice created',
      `${entry.invoice.number} for ${entry.client?.name || 'client'} was generated${entry.recurring.auto_send ? ' — share it with one tap' : ''}.`
    );
  });
  if (created.length) {
    systemNotify('Recurring invoice created', `${created.length} invoice${created.length === 1 ? '' : 's'} generated`);
  }
  refreshFollowUpNotifications();
  save();
  state.booted = true;
}

function render() {
  if (!state.account) {
    renderAuth();
    return;
  }
  if (!state.data.business.business_name) {
    renderOnboarding();
    return;
  }
  switch (state.screen.name) {
    case 'invoices':
      renderInvoices();
      break;
    case 'clients':
      renderClients();
      break;
    case 'settings':
      renderSettings();
      break;
    case 'editor':
      renderEditor();
      break;
    case 'preview':
      renderPreview(state.screen.invoiceId);
      break;
    case 'recurring':
      renderRecurring();
      break;
    case 'upgrade':
      renderUpgrade(state.screen.invoiceId, {});
      break;
    case 'dashboard':
    default:
      renderDashboard();
      break;
  }
  if (!['editor', 'preview', 'recurring', 'upgrade'].includes(state.screen.name)) {
    renderTabbar();
  }
  fabEl.hidden = !(state.screen.name === 'dashboard' || state.screen.name === 'invoices');
  scaleDocs();
  attachSwipe();
}

function boot() {
  state.account = S.auth.current();
  if (state.account) {
    try {
      loadAccount();
    } catch (error) {
      console.error('Could not load data', error);
      toast('Could not read saved data', 'error');
    }
  }
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', scaleDocs);
  window.addEventListener('hashchange', () => {
    if (location.hash === '#new' && state.account) openEditor(null);
    if (location.hash === '#invoices') setTab('invoices');
  });
  if (state.account && location.hash === '#new') openEditor(null);
  else if (state.account && location.hash === '#invoices') setTab('invoices');
  else render();
}

boot();

// Exposed for the smoke test and for debugging in the browser console. Read-only by convention.
window.InvoiceNaija = { state, render, R, S };
