/**
 * Runtime configuration. Safe place for PUBLIC values only.
 * Never put a secret key here: this file is downloaded by every visitor.
 *
 * paystackPublicKey  - your Paystack PUBLIC key (pk_test_... while testing).
 * paystackVerifyUrl  - URL of a server (or Base44 backend function) that verifies a reference with
 *                      your SECRET key before the plan is upgraded. Without it the app stays in
 *                      local test mode and says so on the Upgrade screen.
 * googleClientId     - Google OAuth Web client ID, enables "Continue with Google".
 * whatsappApiHook    - optional WhatsApp Business API endpoint (off by default).
 */
window.INVOICENAIJA_CONFIG = {
  appVersion: '0.2.0-beta',
  googleClientId: '',
  paystackPublicKey: '',
  paystackVerifyUrl: '',
  whatsappApiHook: '',
  supportWhatsApp: '',
};
