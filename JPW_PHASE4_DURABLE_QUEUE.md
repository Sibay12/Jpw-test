# JPW Phase 4 — Durable FIFO Gateway Queue

## Included in this source update
- MongoDB-backed queue jobs, keyed uniquely by order ID.
- FIFO selection by job creation time.
- Atomic job claiming and a distributed MongoDB worker lease so multiple Render instances do not intentionally process jobs in parallel.
- Queue states: `queued`, `processing`, `retry`, `sent`, `failed`.
- Bounded retry policy: up to four total attempts, with increasing delays (10s, 30s, 90s).
- Expired processing leases are recovered and returned to the retry queue.
- Queue job stores a snapshot of gateway routing settings at order submission, so later admin configuration changes do not unexpectedly reroute already-queued orders.
- Admin-only queue monitoring endpoint and dashboard, plus manual retry for failed jobs.
- Approximate queue position and ETA (initial estimate: 25 seconds per order).
- Queue payload is stored in MongoDB and survives process restarts.
- Customer acknowledgement indicates queue acceptance and an approximate wait.
- Queue payload credentials are not returned by the admin API.

## Safety boundaries
- Queue dispatch does not mark an order completed or approve payment.
- On exhausted delivery retries, the order is marked Rejected and flagged for manual refund review. Automatic refund is deliberately not performed here to avoid duplicate credits if the process crashes between a wallet credit and recording that credit.
- Admin retry is available only for jobs in `failed` state.
- The queue uses at-least-once delivery semantics. If a gateway accepted a message but the server crashed before recording the success, a retry may send it again. The external gateway does not expose a universal idempotency key in the current integration.
- ETA is an estimate, not a guarantee; actual gateway response times and retries affect it.
- Target passwords are stored in the queue document because the gateway needs them to dispatch. Keep MongoDB access restricted and ensure backups are protected.

## Validation completed
- `node --check server.js`
- `node --check` on all inline JavaScript blocks in `public/admin.html`
- ZIP integrity check

## Not yet completed
- No live Render deployment was performed.
- No real Telegram/WhatsApp account was exercised from this environment.
- No MongoDB integration test or multi-instance load test was run.
- Queue behavior must be tested on a staging copy or controlled test account before selecting Durable FIFO Queue on the live service.

## Deployment checklist
1. Back up the current Render deployment and MongoDB database.
2. Upload the Phase 4 source to a staging service first.
3. Confirm the service connects to MongoDB and logs `Durable FIFO worker started`.
4. Keep Dispatch Mode set to Direct Send during initial verification.
5. Run a test order in Direct Send and confirm existing behavior is unchanged.
6. Enable Durable FIFO Queue only for a controlled test and verify queue position, send, retry and admin monitor.
7. Confirm failed-job handling and manual refund review with the project owner.
8. Deploy to production only after the client accepts the staging test.
