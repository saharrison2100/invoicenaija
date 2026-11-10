# Building and shipping InvoiceNaija

Everything here is what was actually run for the 0.2.0-beta release, in order.

## 1. Requirements

| Tool | Version used |
| --- | --- |
| Node | 20+ (24 used here) |
| JDK | 17 |
| Android SDK | platform 34, build-tools 34.0.0 |
| Gradle | via the wrapper in `android/` (8.2.1) |
| Chrome/Chromium | only for `npm run test:smoke` |

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

## 2. Web app

The app is plain ES modules plus a stylesheet: no bundler, no framework, no build step. That is deliberate — the whole thing works offline and there is nothing to break between source and shipped code.

```bash
npm ci
npm test                 # 22 unit tests (money, VAT, partial payments, reminders, recurring, plans)
npm run serve            # http://localhost:8080
npm run test:smoke       # end-to-end Chromium test; writes ./screenshots
```

## 3. Android (Capacitor)

```bash
npx cap sync android     # copies www/ → android/app/src/main/assets/public
cd android
./gradlew assembleDebug  # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease  # needs signing below
```

Verify a build before shipping it:

```bash
aapt dump badging app/build/outputs/apk/debug/app-debug.apk | head -3
apksigner verify --print-certs app/build/outputs/apk/debug/app-debug.apk
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep assets/public/index.html
```

### Signing a store build

```bash
keytool -genkeypair -v -keystore release.jks -alias invoicenaija \
  -keyalg RSA -keysize 2048 -validity 10000
```

Add to `android/app/build.gradle`:

```gradle
signingConfigs {
    release {
        storeFile file(System.getenv("INV_KEYSTORE") ?: "release.jks")
        storePassword System.getenv("INV_STORE_PASSWORD")
        keyAlias System.getenv("INV_KEY_ALIAS")
        keyPassword System.getenv("INV_KEY_PASSWORD")
    }
}
buildTypes { release { signingConfig signingConfigs.release } }
```

Never commit the keystore or the passwords; use repository secrets.

## 4. GitHub Actions

`.github/workflows/android.yml` runs on every push to `main`, on `v*` tags and manually:

1. Node 20 + JDK 17 + Android SDK
2. `npm ci`
3. `npm test`
4. `npx cap sync android`
5. `./gradlew assembleDebug`
6. Uploads the APK as an artifact
7. Attaches `InvoiceNaija-debug.apk` to the `v0.2.0-beta` release

## 5. Paystack (going live)

This build ships **no keys**, so the Upgrade screen runs in test mode and says so. To take real money:

1. Create a Paystack account, stay in **test mode**, copy the **public** key (`pk_test_…`).
2. Put it in `www/config.js`:

```js
window.INVOICENAIJA_CONFIG = {
  ...
  paystackPublicKey: 'pk_test_xxxxxxxxxxxxxxxxxxxxx',
  paystackVerifyUrl: 'https://your-backend.example.com/verify-payment',
};
```

The public key is safe in the bundle. The **secret** key (`sk_test_…`) must only ever live on a server.

3. Deploy a small verifier. A Base44 backend function works (see the `backend-functions` docs), and so does any Node host:

```js
// verify-payment.js — GET /verify-payment?reference=...
export default async function handler(request) {
  const reference = new URL(request.url).searchParams.get('reference');
  if (!reference) return Response.json({ ok: false, reason: 'NO_REFERENCE' }, { status: 400 });

  const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  const body = await response.json();
  const tx = body.data || {};
  const success = body.status === true && tx.status === 'success';

  return Response.json({
    ok: success,
    status: tx.status,
    amount: tx.amount,           // kobo, checked against the expected price by the app
    reference: tx.reference,
    email: tx.customer?.email,
  });
}
```

The app only switches the plan to Pro when the verifier answers `{ ok: true, status: 'success' }` **and** the amount is at least the plan price.

4. **Webhook (recommended):** in the Paystack dashboard add `https://your-backend/paystack-webhook`, verify the `x-paystack-signature` HMAC-SHA512 with the secret key, then mark the subscription paid. Because InvoiceNaija is device-local, the webhook is the source of truth for renewals; the app can call the verifier on launch (see `state.data.plan.renews_at`) to keep the plan honest.

5. Go live by swapping `pk_test_…` for `pk_live_…` and the secret on the server.

**Without a verify endpoint** the app upgrades locally after a successful checkout and records the reference in `plan.last_reference`. That is fine for a pilot with people you trust, not for scale — anyone could fake it.

## 6. Google sign-in

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → **Web application**.
2. Authorised JavaScript origins: `https://<your-pages-domain>` and `http://localhost:8080`.
3. Copy the client ID into `www/config.js` as `googleClientId`.
4. `npm run test:smoke` does not need it; the app falls back to phone + PIN.

For the Android WebView, the same Web client ID works for the Google Identity Services button, provided the origin (`https://localhost`) is added — Google does not accept that origin, so in practice Google sign-in is a browser/PWA feature and phone + PIN is the Android path.

## 7. Scheduled recurring invoices

Recurring invoices are generated **when the app is opened** (`runDueRecurring` in `www/js/store.js`), which also catches up on runs missed while the phone was off. For exact-time generation you need a server that owns the schedules:

- Move `recurring` rows to a backend table (Base44 entity, Supabase, Postgres).
- Add a daily cron (GitHub Actions `schedule`, a Base44 scheduled workflow, or a Vercel cron) that runs:

```js
for (const schedule of activeSchedulesDueToday) {
  const invoice = createInvoiceFrom(schedule);   // next number, same items/VAT/discount
  schedule.next_run_date = advanceDate(schedule.next_run_date, schedule.frequency);
  if (schedule.auto_send) queueWhatsApp(schedule.client, invoice);
}
```

- The app keeps working offline and syncs on launch.

## 8. WhatsApp

Reminders and invoice sharing use `https://wa.me/<number>?text=…`, which needs no API key and opens the person's own WhatsApp. A WhatsApp Business API hook is scaffolded: set `whatsappApiHook` in `config.js` and switch it on per business in Settings. Nothing is sent to that endpoint unless both are true.

## 9. Publishing the web app (GitHub Pages)

Pages serves the repository root; `index.html` at the root redirects to `./www/index.html`, which is the app. Enable it under **Settings → Pages → Deploy from branch → main → / (root)**. The service worker scope is `/invoicenaija/www/`, so install works from the app URL.

## 10. Data model

`www/js/store.js` holds the whole model. One JSON document per account in `localStorage` under `invoicenaija:data:<accountId>`:

```
business     { id, owner_id, business_name, phone, whatsapp, address, logo_url,
               bank_name, account_number, account_name, invoice_prefix, vat_default,
               reminder_template, reminder_schedule, brand_color, whatsapp_api_enabled }
clients[]    { id, business_id, name, phone, email, address, created_at }
invoices[]   { id, business_id, client_id, number, issue_date, due_date, items[],
               discount_kobo, vat_enabled, notes, status, paid_at,
               amount_paid, balance_due, recurring_id, pdf_unlocked }
payments[]   { id, invoice_id, business_id, amount_kobo, payment_date, method,
               reference, note, created_at }
receipts[]   { id, payment_id, invoice_id, business_id, receipt_number, pdf_url, issued_at }
recurring[]  { id, business_id, client_id, items[], discount_kobo, vat_enabled, notes,
               frequency, next_run_date, end_date, auto_send, active, runs, last_run_date }
reminder_log[]{ id, invoice_id, channel, sent_at, template_used }
notifications[]{ id, title, body, at, read }
plan         { tier, billing, status, renews_at, last_reference, receipts[] }
```

`amount_paid` and `balance_due` are denormalised for display but always recalculated from the payment ledger; the ledger is the truth. Migrating V1 data adds the new fields and writes a payment row for any invoice that was marked Paid without one.

To move to a server, replace `loadData`/`saveData` with API calls and keep every rule in `www/js/rules.js` — it is pure functions over plain data and does not care where the data comes from.
