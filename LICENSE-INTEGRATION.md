# JPW Central License Integration

## Central authority
- Portal: https://license.takna.online/
- Default API base: `https://license.takna.online/api/v1`
- Optional Render override: `LICENSE_API_BASE` (must end in `/api/v1`; accepts `https://` or `http://`; HTTPS is strongly recommended).
- Product code: `JPW`
- Product endpoints used by this application:
  - `POST /licenses/activate`
  - `POST /licenses/verify`

This integration uses only the central portal's Activate and Verify contracts. The marketplace-only Issue and Manage endpoints are not called by the customer installation. Those endpoints require HMAC authentication and belong on a trusted marketplace/server-to-server workflow.

## Central portal one-time configuration
1. Deploy the supplied TAKNA Central License Portal source to `https://license.takna.online/` and complete its one-time PHP/MySQL setup.
2. Sign in to the central portal as its owner.
3. Open Product & Feature Registry.
4. Register or confirm product code `JPW`, product name `JPW`, status `ACTIVE`.
   - The provided SQL schema creates the `products` table but does not seed the JPW product row. It must be registered in the portal UI before any JPW license can activate.
5. Optionally register feature codes for product entitlements. The JPW application currently uses the active license as a whole-product lock; it does not yet gate each individual UI/API feature against individual feature codes.
6. Create a license with product `JPW`, set expiry and activation limit, and copy the key securely to the customer.

## JPW server configuration
Set these Render environment variables:
- Product code (`JPW`) is fixed in the private backend module. The API URL defaults to `https://license.takna.online/api/v1`; optionally set `LICENSE_API_BASE` in Render to another HTTP or HTTPS API base ending in `/api/v1`.
- `LICENSE_DOMAIN=the-exact-customer-domain.example` (no scheme, no path; must match the incoming host)
- `LICENSE_VERIFY_INTERVAL_MS=21600000` (6 hours; minimum 60 seconds)
- Central API request timeout is fixed at 15 seconds in the backend module.
- `LICENSE_API_BASE` accepts both HTTP and HTTPS. HTTPS is required for production security. Plain HTTP sends license keys and verification payloads without encryption and is vulnerable to interception or modification; use it only for a temporary controlled diagnostic, never as a production workaround.
- `DATA_ENCRYPTION_KEY` must be a stable 32-byte key (64 hexadecimal characters) because the stored license key is encrypted at rest using the existing field encryption utility.
- `SERVER_PUBLIC_URL` should also be the correct HTTPS public URL for the installation.

Do not put a central portal database password or `marketplace_api_secret` in the JPW customer package. Do not put secrets in browser JavaScript or `.env.example`.

## Customer activation flow
1. Customer extracts and deploys the JPW package.
2. Customer opens the site; the app displays `/license` until a valid license is activated.
3. Customer enters the license key.
4. JPW backend calls the central Activate endpoint using the configured `LICENSE_API_BASE` (HTTPS by default) with `product`, `licenseKey`, `installationId`, `domain`, and optional `owner`.
5. Central portal validates product, license status, expiry, domain and activation limit.
6. JPW stores the license key encrypted in MongoDB and the persistent installation ID in its own database.
7. The application starts its background workers and bot integrations only after successful activation.
8. JPW periodically calls central Verify. If verification fails, the web application fails closed and remains locked until verification succeeds.

## Important behaviour and limits
- The application is locked by default when no license exists.
- `/health`, `/license`, `/api/license/status`, `/api/license/activate`, and `/api/license/verify` remain reachable for health and activation/recovery.
- A central API outage does not unlock the product. There is no offline grace period because the supplied license guide does not define one.
- License expiry, suspension, revocation, wrong product, wrong domain and activation-limit rejection are enforced by the central portal.
- The license key is not returned to the browser after activation.
- The integration currently enforces a whole-product license lock. Per-feature entitlement enforcement and tenant-specific license policy are future work.
- The central portal's Product & Feature Registry must have `JPW` enabled. A README statement alone does not seed this row.

## Validation before production
1. Confirm `GET https://license.takna.online/api/v1/status` responds successfully.
2. Confirm `JPW` is registered and ACTIVE in Product & Feature Registry.
3. Create a short-lived test JPW license with a low activation limit.
4. Activate on a test domain.
5. Verify same domain and installation.
6. Test wrong key, wrong product, wrong domain, second installation, expiry, suspension and revocation.
7. Simulate central API timeout; JPW must stay locked.
8. Confirm no key or secret appears in browser source, logs or public environment.
9. Only after all tests pass, issue the production license.

## Central portal source audit note
The supplied portal's API response schemas match the Activate/Verify client used here:
- Activate returns `success`, `active`, `status`, and `license.customer`, `license.expiresAt`, `license.features`.
- Verify expects `product`, `licenseKey`, `installationId`, and `domain`, and returns the same active license envelope.

The portal's `products` table is not pre-populated by `schema.sql`; register `JPW` in the portal UI. The supplied guide correctly warns that endpoint availability alone is not proof of product registration or operational status.


## Fetch failed / Central connection troubleshooting

The JPW backend calls the central API server-to-server. Render Environment must contain:

```env
The API URL (`https://license.takna.online/api/v1`), product code (`JPW`) and 15-second request timeout are hardcoded in `utils/centralLicense.js`. Do not add these as Render Environment Variables.
```

The central API URL and product code are fixed in the backend module. The JPW server reports DNS (`ENOTFOUND`), TLS/certificate, connection reset and timeout failures more specifically. Never disable TLS certificate verification.

If the error names DNS/TLS/connectivity, check that `https://license.takna.online/api/v1/status` is reachable over HTTPS from the public internet and that the domain certificate is valid. The central API activation URL must be `https://license.takna.online/api/v1/licenses/activate`. If it returns a non-JSON page/404, check the PHP host's nested `index.php` routing and HTTPS configuration.
