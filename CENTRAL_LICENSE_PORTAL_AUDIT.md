# Central TAKNA License Portal — Source Audit Findings

Reviewed the supplied `TAKNA_Central_License_Portal_Complete_Source.zip`.

## Contract confirmed for JPW activation
- Activate: `POST /api/v1/licenses/activate`
- Verify: `POST /api/v1/licenses/verify`
- Product code is checked against the `products` table and must be ACTIVE.
- License checks include product match, license status, expiry, optional domain binding, and activation count.
- Activation binds an installation ID and domain.
- Verify requires a previously registered activation for the same license, installation ID, and domain.
- Active responses include `success`, `active`, `status`, and `license.customer`, `license.expiresAt`, `license.features`.

## Required central portal action
The supplied `schema.sql` creates the `products` and `features` tables but does not insert a `JPW` product row. Register `JPW` in Admin → Product & Feature Registry and ensure it is ACTIVE before attempting customer activation. Then create a license for product `JPW`.

## Endpoints not used by the customer installation
- Issue and Manage require server-to-server HMAC headers `X-TAKNA-Timestamp` and `X-TAKNA-Signature`.
- JPW customer installations do not call Issue or Manage. They only call Activate and Verify.
- Never put `marketplace_api_secret` in the customer ZIP, browser code, or APK.

## Source inconsistency to review on the central portal
The central portal README says the Issue endpoint never returns the plaintext license key, but the supplied `api/v1/licenses/issue/index.php` currently includes `licenseKey` in both its idempotent and new-issuance JSON responses. This is not used by the JPW activation integration. If the marketplace issuance endpoint is used later, reconcile the API contract and protect the returned key as a one-time sensitive credential.

## Verification limitation
This was a static source audit of the supplied ZIP. The deployed portal URL, database, product registry, SSL configuration, and live API responses were not accessed or tested. A successful live activation test remains required before production distribution.
