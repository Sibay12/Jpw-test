# JPW Live-Server UI Refresh

## Scope and compatibility
This release changes the presentation layer only:
- `public/admin.html`
- `public/mobile_app.html`
- `public/index.html`
- `public/jpw-theme.css` (new)
- `public/jpw-theme.js` (new)

Existing server routes, API handlers, MongoDB models, Telegram/WhatsApp code, payment code, login flows, element IDs, and existing page event handlers were not intentionally changed. Dark mode is the default on first visit to preserve the current dark visual baseline. Users can switch to Light mode; the preference is stored in their own browser.

## IMPORTANT: Do not overwrite the whole live project folder
For the safest live update, upload/replace only the five files listed above. Do not replace `server.js`, `bot.js`, `whatsapp.js`, `package.json`, database files, or environment variables for a UI-only update.

## Before uploading (mandatory)
1. In your hosting file manager or deployment source, make a complete backup/snapshot of the current live project.
2. Confirm the backup can be restored. Keep the previous three HTML files.
3. Upload the three updated HTML files and the two new `jpw-theme` assets into the existing `public/` directory.
4. Preserve the existing `.env` and hosting environment variables. Never upload a ZIP's `.env` to a public or shared location.
5. If the host deploys from Git, commit the five-file change and retain the previous commit hash for instant rollback.

## After uploading
- Open `/admin`, `/app`, and `/` in a private/incognito browser window.
- Check admin login and customer login.
- Check existing order forms, passbook/status, offers, packages and theme toggle.
- Perform a small, controlled payment test only if your payment provider supports a safe test mode. Do not make a real customer payment just to test.
- Check Telegram and WhatsApp integrations; this UI-only change does not modify their server code.
- If anything looks wrong, restore the backed-up five files (or revert the deployment commit).

## Security
The source archive's `.env` was excluded from this output because it may contain secrets. The live server's existing environment configuration must remain untouched. Rotate any real keys/passwords that were exposed in the original uploaded archive.

## Validation status
The ZIP structure and HTML asset references were checked. This is not a live-server test; actual browser, authentication, payment, Telegram and WhatsApp behavior can only be confirmed on your hosting environment. No software change can honestly guarantee zero production risk, so take the backup and keep rollback ready.

---

## v2.16.1 Security Upgrade — additional deployment steps

Before deploying v2.16.1, take a verified MongoDB backup. Configure `CORS_ORIGINS` and a stable `DATA_ENCRYPTION_KEY` in Render Environment. If supported by the payment provider, configure `PRIVATE_WEBHOOK_SECRET` and update the provider to send the HMAC signature header.

Run the v2.16.1 database migration against a staging clone first:

```bash
npm run migrate:v2.16.1
```

The migration modifies unique indexes and encrypts existing target credentials. Do not run it against production without a restorable backup. After staging validation, run the same migration against production during a maintenance window, then deploy the matching v2.16.1 commit. Keep the encryption key unchanged across deploys and restores.

Tenant API routes currently cover customer registration/login and tenant-scoped profile/order/payment-history reads only. Existing UI and operational payment/gateway workflows remain legacy-only; do not sell or activate full SaaS tenant processing from this release.
