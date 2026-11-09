# JPW Phase 5 — SaaS Tenant Control Plane Foundation

## Implemented in this source update
- Tenant registry model with unique tenant ID and workspace slug.
- Owner profile metadata (name and email).
- Tenant lifecycle states: trial, active, past_due, suspended and cancelled.
- Initial subscription history records with plan, amount, currency, billing cycle, dates and notes.
- Starter plan catalogue: Free, Starter, Growth and Business.
- Super-admin APIs to list/create tenants, update status/plan/period end, and rotate tenant API keys.
- Admin Panel navigation item and SaaS Tenant Management screen.
- Generated tenant API keys use high-entropy random values. Only SHA-256 hashes are stored; the raw key is displayed once at creation/rotation.
- Tenant API-key authentication middleware and `/api/tenant/context` endpoint.
- Tenant metadata fields added to core user, order, payment and gateway-queue schemas, defaulting to `legacy` for existing records.
- Trial length validation (0–30 days), status checks, and key rotation invalidates the previous key.
- Tenant key and tenant secrets are not returned in tenant list responses.

## Important: this is a control-plane milestone, not production multi-tenant data isolation
The existing JPW customer/order routes still use the legacy single-tenant authentication and query paths. The new tenant registry does not yet partition customer accounts, orders, payments, gateway settings, queue jobs or admin permissions by tenant. Existing unique indexes (for example, Telegram chat ID) are still global.

For that reason:
- Do not onboard external paying customers onto this build yet.
- Do not share tenant API keys as if they enable customer order processing.
- `/api/tenant/context` currently validates the tenant key and returns the tenant's plan/status metadata only.
- The next required milestone is tenant-scoped user authentication, tenant-scoped database queries and compound unique indexes, plus isolation tests that prove one tenant cannot read or mutate another tenant's records.

## Plan catalogue note
The Free / Starter / Growth / Business prices and limits in the Admin Panel are initial editable-product assumptions for development review, not a final commercial offer. No payment collection, auto-renewal, invoice generation, proration or production quota enforcement is enabled in this phase.

## Validation completed
- `node --check server.js`
- `node --check` on all inline JavaScript blocks in `public/admin.html`
- ZIP integrity check
- Static inspection of route registration, tenant API-key hashing and secret omission from tenant list responses

## Not performed
- No live Render deployment.
- No production MongoDB migration or index conversion.
- No live tenant onboarding.
- No payment gateway integration for subscription billing.
- No end-to-end or multi-tenant penetration test.

## Recommended next steps before production SaaS launch
1. Back up Render service and MongoDB.
2. Deploy to a separate staging service.
3. Verify super-admin tenant creation and one-time API-key display.
4. Verify tenant context endpoint using the tenant key.
5. Test trial expiration, suspension, plan changes and key rotation.
6. Complete Phase 6: migrate every customer/order/payment/settings/queue query to mandatory tenant scope, replace global uniqueness with tenant-scoped compound indexes where appropriate, and add cross-tenant isolation tests.
7. Only after Phase 6 security tests pass, enable external customer onboarding and subscription billing.
