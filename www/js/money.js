/**
 * Naira money helpers.
 *
 * Every amount in InvoiceNaija is an integer number of kobo (1 naira = 100 kobo). Floating point
 * money is how invoices end up a kobo wrong, so it never touches an amount: parsing and formatting
 * are the only two places text meets money, and both live here.
 */

const formatter = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "1500" | "1,500.50" | "₦ 2 500" -> integer kobo. Never throws. */
export function parseToKobo(raw) {
  if (raw === null || raw === undefined) return 0;
  const cleaned = String(raw).replace(/[^\d.,-]/g, '');
  if (!cleaned) return 0;

  // Work out which separator is the decimal point: the last one followed by one or two digits.
  let decimalSep = null;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);
  if (lastSep >= 0) {
    const digitsAfter = cleaned.length - lastSep - 1;
    if (digitsAfter >= 1 && digitsAfter <= 2) decimalSep = cleaned[lastSep];
  }

  const negative = cleaned.startsWith('-');
  let digits = '';
  let seenDecimal = false;
  for (const ch of cleaned) {
    if (ch >= '0' && ch <= '9') digits += ch;
    else if (decimalSep && ch === decimalSep && !seenDecimal) {
      digits += '.';
      seenDecimal = true;
    }
  }
  if (!digits || digits === '.') return 0;

  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) return 0;
  const kobo = Math.round(value * 100);
  return negative ? -kobo : kobo;
}

/** 150050 -> "1,500.50" */
export function plain(kobo) {
  const safe = Number.isFinite(kobo) ? Math.round(kobo) : 0;
  const sign = safe < 0 ? '-' : '';
  return sign + formatter.format(Math.abs(safe) / 100);
}

/** 150050 -> "₦1,500.50" */
export function format(kobo) {
  const safe = Number.isFinite(kobo) ? Math.round(kobo) : 0;
  return (safe < 0 ? '-₦' : '₦') + formatter.format(Math.abs(safe) / 100);
}

/** Drops ".00" on whole naira, for tight cards: "₦15,000". */
export function compact(kobo) {
  const text = format(kobo);
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

/** Amount as text for an input field: 150050 -> "1500.50" (no symbol, no grouping). */
export function forInput(kobo) {
  if (!kobo) return '';
  const naira = Math.floor(Math.abs(kobo) / 100);
  const koboPart = String(Math.abs(kobo) % 100).padStart(2, '0');
  return koboPart === '00' ? String(naira) : `${naira}.${koboPart}`;
}
