# JPW Gateway Routing Upgrade – Delivery Notes

## Scope delivered in this build

This update adds the first working slice of the configurable multi-gateway order-routing architecture to the existing JPW project.

### Implemented
- New Admin Panel tab: **Gateway Routing**.
- Admin-protected APIs:
  - `GET /api/admin/gateway-routing`
  - `POST /api/admin/gateway-routing`
- Persistent configuration stored in the existing MongoDB `Setting` collection under key `gatewayRouting`.
- Routing modes:
  - `telegram` – existing Telegram MTProto order forwarding (default).
  - `whatsapp` – sends the exact two-line `Target ID` + `Password` payload to a configured WhatsApp destination using the existing linked Baileys session (without the customer-message reference footer).
  - `both` – sends one internal order to selected enabled channels; parallel or sequential strategy.
  - `custom` – primary gateway with optional backup/fallback.
- Direct/queue preference is stored and shown in Admin Panel. **Queue selection is not yet a live queue worker**; until the durable queue phase is implemented, the server deliberately uses direct dispatch and logs this fact.
- Each new order records the selected gateway mode, dispatch preference and per-channel send results.
- Existing Telegram path remains the default when no routing settings have been saved.
- Actual WhatsApp destination number is configured separately from the customer's WhatsApp chat connection.
- Admin UI loads and saves settings using the existing `x-admin-pass` authentication mechanism.

## Configure

1. Deploy the updated project.
2. Open the existing Admin Panel and sign in.
3. Open **Gateway Routing**.
4. Choose Telegram Only, WhatsApp Only, Both Gateways, or Primary + Backup.
5. For WhatsApp, enter the destination number with country code (digits only), enable WhatsApp Gateway, and ensure the linked WhatsApp session is connected.
6. Save the configuration.
7. First test using a controlled destination and a non-production test order.

## Important limitations – not represented as completed

The user's full requested public SaaS scope is larger than this first routing milestone. These items still require implementation and testing:

1. Incoming WhatsApp external-gateway reply correlation and parsing.
2. Configurable reply count, regex/contains/exact matching, extracted field definitions, reply meanings, status mapping, and customer-visible filtered templates.
3. Persistent FIFO queue worker, concurrency controls, queue positions, ETA recalculation and completion notifications.
4. Per-service, per-customer and per-order routing overrides (current settings are global for this first milestone).
5. Safe handling of both-gateway partial success, external message correlation and duplicate side-effect prevention.
6. Manual customer-submitted payment requests, UTR/proof review, admin approve/reject workflow, idempotent wallet credit, and admin WhatsApp alert.
7. PostgreSQL/SQL support. The current application is deeply coupled to Mongoose models; adding a connection string alone would not create real SQL compatibility. A repository/data-access abstraction and tested migrations are required.
8. Full multi-tenant/public SaaS isolation, tenant-scoped gateway credentials and WhatsApp sessions, subscription billing, usage limits and tenant administration.
9. Official WhatsApp Business Cloud API connector. This build uses the existing linked-device/Baileys connection only.

## Safety and deployment notes

- The real `.env` file is intentionally excluded from this ZIP. Recreate it from `.env.example` and configure secrets in the deployment environment.
- Never put gateway passwords, tokens, session keys or database credentials in frontend code.
- Do not use the Both mode with a real production service until reply correlation and partial-success reconciliation have been completed and tested.
- The WhatsApp destination must be controlled by you or otherwise authorized to receive these messages. Follow WhatsApp's applicable policies.
- Keep a database backup before deployment. This change adds fields to the existing Order schema; Mongoose will persist them on new/updated records without a destructive migration.
- Validate on a staging service before replacing the live service. Do not deploy this first milestone directly to production without a rollback backup.

## Validation performed

- `node --check server.js` passed.
- Admin Panel inline JavaScript syntax checks passed.
- No live MongoDB, Telegram or WhatsApp credentials were available for an end-to-end integration test in this environment.

## Phase 2 – WhatsApp external reply intake (implemented in the next build)

### Added in Phase 2
- Incoming replies are inspected only when they come from the configured external WhatsApp gateway destination.
- Replies are correlated to an active order by target ID when present (password matching is intentionally avoided to prevent accidental matches).
- If the provider omits the target reference, the handler assigns a reply only when exactly one recent eligible WhatsApp order exists. Ambiguous replies are not assigned.
- Incoming reply records include message ID, received time, match method, detected reply category and the original reply text (admin-only view).
- Duplicate WhatsApp message IDs are ignored for the same order; the latest 25 replies are retained on an order.
- Basic reply categories are detected: success candidate, failure candidate, in progress, or unclassified.
- New admin-only endpoint: `GET /api/admin/gateway-replies`.
- Gateway Routing admin tab includes a recent incoming-replies table.
- WhatsApp dispatch records the outbound message ID and dispatch time for stronger correlation/audit context.

### Deliberate safety boundaries
- Phase 2 does not automatically mark an order Completed/Rejected and does not issue refunds based on external reply text.
- The detected category is a candidate only. Configurable matching rules, extraction, customer-facing templates and final status mapping belong to Phase 3.
- Replies from numbers other than the configured gateway destination are ignored by this external-gateway handler.
- Replies that cannot be safely matched are left unassigned and logged; the system does not guess between multiple active orders.

### Validation
- `node --check server.js` passed.
- `node --check whatsapp.js` passed.
- Both inline JavaScript blocks in `public/admin.html` passed `node --check`.
- ZIP integrity check passed.
- No live WhatsApp session or production database was available; end-to-end gateway reply testing remains required in a controlled test environment.


## Phase 5 — SaaS tenant control-plane foundation
See `JPW_PHASE5_SAAS_TENANT_FOUNDATION.md` for tenant registry, subscription metadata, super-admin management, one-time API-key handling, validation results and the remaining tenant data-isolation work.
