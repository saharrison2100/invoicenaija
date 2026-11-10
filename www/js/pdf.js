/**
 * Invoice and receipt documents.
 *
 * The same HTML is used for the on-screen preview and for the PDF, so what a client sees on the
 * phone cannot drift from what lands in their WhatsApp. The PDF itself is rendered by html2canvas
 * and jsPDF (both vendored, so the app works offline).
 *
 * On Android (Capacitor) the file is written to the app cache and handed to the system share sheet,
 * because a WebView cannot save a blob download on its own.
 */

import { format, plain } from './money.js';
import { invoiceTotals, invoiceTotal, shortDate, effectiveStatus, STATUS, paidKobo } from './rules.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());

function brandColor(business) {
  const colour = String(business?.brand_color || '').trim();
  return /^#[0-9a-f]{6}$/i.test(colour) ? colour : '#0B6E4F';
}

/** The full A4 invoice document. `brandable` false keeps the free-plan template plain. */
export function invoiceDocHtml({ business, client, invoice, payments = [], brandable = true }) {
  const totals = invoiceTotals(invoice);
  const paid = paidKobo(invoice.id, payments);
  const balance = Math.max(0, totals.total - Math.min(totals.total, paid));
  const status = effectiveStatus(invoice, payments);
  const colour = brandable ? brandColor(business) : '#0B6E4F';
  const logo =
    brandable && business?.logo_url
      ? `<img class="doc-logo" src="${escapeHtml(business.logo_url)}" alt="logo" />`
      : '';
  const addressLines = [business?.address, business?.phone ? `Tel ${business.phone}` : '', business?.whatsapp ? `WhatsApp ${business.whatsapp}` : '']
    .filter(Boolean)
    .join('\n');
  const clientLines = [client?.phone, client?.email, client?.address].filter(Boolean).join('\n');

  const rows = invoice.items
    .filter((item) => item.description || item.unit_price)
    .map(
      (item) => `
      <tr>
        <td class="desc">${escapeHtml(item.description || 'Item')}</td>
        <td class="num">${item.qty}</td>
        <td class="num">${plain(item.unit_price)}</td>
        <td class="num">${plain(Math.round(item.qty * item.unit_price))}</td>
      </tr>`
    )
    .join('');

  const statusText =
    status === STATUS.PAID
      ? `PAID ${shortDate(invoice.paid_at || invoice.issue_date).toUpperCase()}`
      : `DUE ${shortDate(invoice.due_date).toUpperCase()}`;

  return `
  <div class="doc" style="--doc-colour:${colour}">
    <div class="doc-head">
      <div class="doc-brand">
        ${logo}
        <div>
          <h2>${escapeHtml(business?.business_name || 'Your business')}</h2>
          <div class="lines">${escapeHtml(addressLines)}</div>
        </div>
      </div>
      <div class="doc-title">
        <h1>INVOICE</h1>
        <div class="doc-meta">
          <span>No.</span><b>${escapeHtml(invoice.number)}</b>
          <span>Issued</span><b>${shortDate(invoice.issue_date)}</b>
          <span>Due</span><b>${shortDate(invoice.due_date)}</b>
        </div>
      </div>
    </div>

    <div class="doc-parties">
      <div class="doc-bill">
        <div class="label">Bill to</div>
        <div class="name">${escapeHtml(client?.name || 'No client')}</div>
        <div class="lines">${escapeHtml(clientLines)}</div>
      </div>
      <div class="doc-due">
        <div class="label">${balance > 0 && paid > 0 ? 'Balance due' : 'Amount due'}</div>
        <div class="value">${format(balance > 0 && paid > 0 ? balance : totals.total)}</div>
        <div class="status">${escapeHtml(statusText)}</div>
        ${paid > 0 && balance > 0 ? `<div class="meta">${format(Math.min(totals.total, paid))} already paid</div>` : ''}
      </div>
    </div>

    <table class="doc-table">
      <thead>
        <tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${rows || '<tr><td class="desc">No items</td><td class="num"></td><td class="num"></td><td class="num"></td></tr>'}</tbody>
    </table>

    <div class="doc-totals">
      <div class="line"><span>Subtotal</span><span>${plain(totals.subtotal)}</span></div>
      ${totals.discount ? `<div class="line"><span>Discount</span><span>-${plain(totals.discount)}</span></div>` : ''}
      ${totals.vat ? `<div class="line"><span>VAT (7.5%)</span><span>${plain(totals.vat)}</span></div>` : ''}
      <div class="grand"><span>TOTAL</span><span class="amount">${format(totals.total)}</span></div>
      ${paid > 0 ? `<div class="line"><span>Paid</span><span>-${plain(Math.min(totals.total, paid))}</span></div>` : ''}
      ${paid > 0 ? `<div class="grand"><span>BALANCE DUE</span><span class="amount">${format(balance)}</span></div>` : ''}
    </div>

    <div class="doc-pay">
      <div class="label">Pay now</div>
      ${
        business?.bank_name || business?.account_number
          ? `<div class="bank">${escapeHtml([business.bank_name, business.account_number].filter(Boolean).join('  •  '))}</div>
             ${business.account_name ? `<div class="meta">Account name: ${escapeHtml(business.account_name)}</div>` : ''}
             ${business.whatsapp ? `<div class="meta">Send proof of payment to ${escapeHtml(business.whatsapp)}</div>` : ''}`
          : `<div class="meta">Transfer ${format(balance)} and send proof of payment to the business.</div>`
      }
    </div>

    ${invoice.notes ? `<div class="doc-notes"><b>Notes</b><br />${escapeHtml(invoice.notes)}</div>` : ''}

    <div class="doc-foot">
      <span>Thank you for your business.</span>
      <span class="made">Made with InvoiceNaija${brandable ? '' : ' • Free plan'}</span>
    </div>
  </div>`;
}

/** The branded receipt issued for one payment. */
export function receiptDocHtml({ business, client, invoice, payment, receipt, payments = [], brandable = true }) {
  const totals = invoiceTotals(invoice);
  const paid = paidKobo(invoice.id, payments);
  const balance = Math.max(0, totals.total - Math.min(totals.total, paid));
  const colour = brandable ? brandColor(business) : '#0B6E4F';
  const logo =
    brandable && business?.logo_url ? `<img class="doc-logo" src="${escapeHtml(business.logo_url)}" alt="logo" />` : '';

  return `
  <div class="doc doc-receipt" style="--doc-colour:${colour}">
    <div class="doc-head">
      <div class="doc-brand">
        ${logo}
        <div>
          <h2>${escapeHtml(business?.business_name || 'Your business')}</h2>
          <div class="lines">${escapeHtml([business?.address, business?.phone].filter(Boolean).join('\n'))}</div>
        </div>
      </div>
      <div class="doc-title">
        <h1>RECEIPT</h1>
        <div class="doc-meta">
          <span>No.</span><b>${escapeHtml(receipt.receipt_number)}</b>
          <span>Date</span><b>${shortDate(payment.payment_date)}</b>
          <span>Invoice</span><b>${escapeHtml(invoice.number)}</b>
        </div>
      </div>
    </div>

    <div class="doc-parties">
      <div class="doc-bill">
        <div class="label">Received from</div>
        <div class="name">${escapeHtml(client?.name || 'Client')}</div>
        <div class="lines">${escapeHtml([client?.phone, client?.address].filter(Boolean).join('\n'))}</div>
      </div>
      <div class="doc-due">
        <div class="label">Amount received</div>
        <div class="value">${format(payment.amount_kobo)}</div>
        <div class="status">${escapeHtml(String(payment.method || 'Payment').toUpperCase())}</div>
      </div>
    </div>

    <table class="doc-table">
      <thead>
        <tr><th>Description</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>
        <tr>
          <td class="desc">Payment towards invoice ${escapeHtml(invoice.number)}${payment.reference ? `<br /><span class="meta">Ref: ${escapeHtml(payment.reference)}</span>` : ''}</td>
          <td class="num">${plain(payment.amount_kobo)}</td>
        </tr>
      </tbody>
    </table>

    <div class="doc-totals">
      <div class="line"><span>Invoice total</span><span>${plain(totals.total)}</span></div>
      <div class="line"><span>Total paid</span><span>${plain(Math.min(totals.total, paid))}</span></div>
      <div class="grand"><span>BALANCE REMAINING</span><span class="amount">${format(balance)}</span></div>
    </div>

    <div class="doc-notes">
      <b>Thank you${client?.name ? `, ${escapeHtml(client.name.split(' ')[0])}` : ''}!</b><br />
      Your payment has been received and recorded. ${balance > 0 ? `Balance remaining: ${format(balance)}.` : 'This invoice is now fully paid.'}
    </div>

    <div class="doc-foot">
      <span>Receipt ${escapeHtml(receipt.receipt_number)} • ${shortDate(receipt.issued_at)}</span>
      <span class="made">Made with InvoiceNaija</span>
    </div>
  </div>`;
}

export function invoiceFilename(business, client, invoice) {
  const who = (client?.name || 'Invoice').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  const from = (business?.business_name || '').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '');
  return `${from ? `${from}_` : ''}${invoice.number}_${who}.pdf`;
}

export function receiptFilename(business, client, receipt) {
  const who = (client?.name || 'Client').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  return `${receipt.receipt_number}_${who}.pdf`;
}

/**
 * Turns a document element into a PDF. Returns the jsPDF instance plus a blob.
 * Multi-page: the rendered canvas is sliced into A4 pages so nothing is ever cut off.
 */
export async function documentToPdf(element) {
  const { jsPDF } = window.jspdf;
  const canvas = await window.html2canvas(element, {
    scale: 2,
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
    windowWidth: element.scrollWidth,
  });
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageWidth = 210;
  const pageHeight = 297;
  const imageWidth = pageWidth;
  const imageHeight = (canvas.height * imageWidth) / canvas.width;
  const image = canvas.toDataURL('image/jpeg', 0.94);

  let remaining = imageHeight;
  let position = 0;
  pdf.addImage(image, 'JPEG', 0, 0, imageWidth, imageHeight);
  remaining -= pageHeight;
  while (remaining > 0) {
    position -= pageHeight;
    pdf.addPage();
    pdf.addImage(image, 'JPEG', 0, position, imageWidth, imageHeight);
    remaining -= pageHeight;
  }
  return { pdf, blob: pdf.output('blob') };
}

/** Saves or shares the PDF, using the native bridge on Android and a download in the browser. */
export async function deliverPdf(pdf, filename, { share = false, title = 'Invoice' } = {}) {
  if (isNative()) {
    const base64 = pdf.output('datauristring').split(',')[1];
    const filesystem = window.Capacitor.Plugins.Filesystem;
    const sharePlugin = window.Capacitor.Plugins.Share;
    const written = await filesystem.writeFile({
      path: filename,
      data: base64,
      directory: 'CACHE',
      recursive: true,
    });
    if (sharePlugin) {
      await sharePlugin.share({
        title,
        text: title,
        url: written.uri,
        dialogTitle: 'Save or share your PDF',
      });
      return { shared: true, uri: written.uri };
    }
    return { shared: false, uri: written.uri };
  }

  const blob = pdf.output('blob');
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return { shared: true };
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { shared: false, downloaded: true };
}
