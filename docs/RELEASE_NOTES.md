# InvoiceNaija 0.2.0-beta

Second release. V1 stays intact; everything below is additive.

## Partial payments
Record a payment against any invoice: amount, date, method (Cash/Transfer/POS/Other), reference and note.
An amount above the balance is refused. Status becomes Partially Paid, then Paid, automatically, and the
dashboard and client totals use balances instead of invoice totals. Each invoice shows a balance-due bar
and its full payment history.

## Receipts
Every payment issues a branded PDF receipt (REC-001, REC-002 … per business) with the logo, business
details, invoice reference, amount paid, balance remaining and a thank-you line. Download, share on
WhatsApp or email it. Receipts are listed per invoice and per client.

## Payment reminders
Editable template with {client_name} {invoice_number} {amount_due} {due_date} {business_name} {pay_link},
a schedule of 3 days before, on the due date, and 3/7/14 days after, a one-tap WhatsApp send with the
message prefilled, a reminder log per invoice, and in-app notifications when invoices need follow-up.

## Recurring invoices
Weekly, monthly, quarterly or yearly, with an optional end date, auto-notify and pause/resume. Due
schedules generate the next numbered invoice, including runs missed while the app was closed. Because
this build has no server, generation happens when the app is opened; docs/BUILD.md describes the cron
job for exact timing.

## Plans
Free: 3 invoices a month, basic template. Pro: ₦2,500/month or ₦20,000/year. Pay-per-invoice: ₦200 to
unlock one branded PDF. Usage counter, upgrade screen, Paystack checkout wiring and a paywall that never
blocks viewing or getting paid on existing invoices. This build runs Paystack in clearly-labelled test
mode (no keys committed); docs/BUILD.md explains going live.

## Dashboard v2
Partially-paid count, collected this month, a six-month collections chart and a needs-follow-up list.

## Install
Download `InvoiceNaija-debug.apk` and allow install from unknown sources. Debug-signed for assessment.

## Verification
22 unit tests (`npm test`) plus an end-to-end Chromium smoke test (`npm run test:smoke`) that signs up,
onboards, records a partial payment, issues a receipt, downloads both PDFs, prefills a reminder, upgrades
in test mode, runs a recurring schedule, reloads to prove persistence, and hits the free-plan paywall.
