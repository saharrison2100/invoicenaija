/**
 * Paystack checkout.
 *
 * Without a public key the app runs in local test mode: the Upgrade screen says so plainly and the
 * unlock happens on the device. That keeps assessment possible offline and, more importantly, never
 * pretends a real payment happened.
 *
 * With a public key the real inline checkout opens. A Paystack reference is only trustworthy after
 * the transaction is verified with the SECRET key, which must never ship in this bundle: set
 * `paystackVerifyUrl` in config.js to a small backend (docs/BUILD.md has a Base44 function example)
 * and the app will require { ok: true, plan: "Pro" } before upgrading.
 */

export function config() {
  return window.INVOICENAIJA_CONFIG || {};
}

export function paystackReady() {
  return Boolean(String(config().paystackPublicKey || '').trim());
}

export function hasVerifyEndpoint() {
  return Boolean(String(config().paystackVerifyUrl || '').trim());
}

export function isTestMode() {
  return !paystackReady();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Paystack. Check your connection.'));
    document.head.appendChild(script);
  });
}

export function newReference(prefix = 'INV') {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

/**
 * Opens Paystack inline checkout. Resolves with { reference } on success, rejects if the person
 * closes the sheet or loading fails.
 */
export async function checkout({ email, amountKobo, reference, metadata = {}, onClose }) {
  if (!paystackReady()) throw new Error('TEST_MODE');
  await loadScript('https://js.paystack.co/v1/inline.js');
  if (!window.PaystackPop) throw new Error('Could not load Paystack. Check your connection.');

  return new Promise((resolve, reject) => {
    const handler = window.PaystackPop.setup({
      key: config().paystackPublicKey,
      email: email || 'customer@invoicenaija.app',
      amount: Math.round(amountKobo),
      currency: 'NGN',
      ref: reference || newReference(),
      metadata: { ...metadata, app: 'InvoiceNaija' },
      callback: (response) => resolve({ reference: response.reference }),
      onClose: () => {
        onClose?.();
        reject(new Error('CANCELLED'));
      },
    });
    handler.openIframe();
  });
}

/**
 * Asks the configured backend to verify a reference with Paystack's secret key.
 * Returns true only when the backend confirms a successful, matching payment.
 */
export async function verifyOnServer(reference, expectedKobo) {
  const url = config().paystackVerifyUrl;
  if (!url) return { verified: false, reason: 'NO_VERIFY_ENDPOINT' };
  try {
    const response = await fetch(`${url}?reference=${encodeURIComponent(reference)}`, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.json();
    const paidEnough = !expectedKobo || Number(body.amount || 0) >= expectedKobo;
    return {
      verified: Boolean(body.ok) && body.status === 'success' && paidEnough,
      reason: body.reason || (paidEnough ? 'OK' : 'UNDERPAID'),
      raw: body,
    };
  } catch (error) {
    return { verified: false, reason: 'NETWORK', error };
  }
}
