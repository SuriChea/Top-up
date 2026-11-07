<<<<<<< HEAD
# InBlack Top-Up

A Docker Compose starter for the customer top-up flow: PostgreSQL-backed product listing and checkout, signed payment webhooks, a separate fulfillment worker, a payment/game simulator, and live order tracking.

## Run locally

1. Copy `.env.example` to `.env`, set unique `AUTH_SECRET` and `TRACKING_TOKEN_SECRET` values, and add trusted admin emails to `ADMIN_EMAILS`. Example secrets are for development only.
2. Run `docker compose up --build`.
3. Open the storefront at <http://localhost:3000>, the API at <http://localhost:8080>, and the OTP inbox at <http://localhost:8025>.
4. Sign in at `/login`. OTP messages are delivered to Mailpit locally. Emails listed in `ADMIN_EMAILS` receive admin access; all others are customers.
5. To reconcile a settlement, open `/admin` as an administrator and upload a CSV with `event_id,order_id,amount_satang,currency,type` columns. Amounts are integer satang; event types are `payment.succeeded`, `payment.failed`, or `payment.refunded`.

PostgreSQL and Redis data are stored in named Docker volumes. Seed products and discount codes are inserted when the database volume is first created. To re-run the seed from scratch, remove only this project's `postgres-data` volume after stopping the stack.

## Services

| Service | Purpose |
| --- | --- |
| `web` | Next.js storefront |
| `proxy` | Nginx round-robin API proxy |
| `api-1`, `api-2` | Stateless REST API replicas |
| `worker` | Expiry scanning, retries, and game fulfillment |
| `postgres`, `redis` | Persistent domain state and cross-replica events/rate limits |
| `mock-pay`, `mock-game` | Local provider simulators |
| `mailpit` | Local SMTP inbox for sign-in codes and OTP testing |

## Test

Run backend tests with `npm test --prefix backend`. Frontend lint, type-check, and production build are `npm run lint --prefix frontend`, `npx --prefix frontend tsc --noEmit -p frontend/tsconfig.json --incremental false`, and `npm run build --prefix frontend`. For browser E2E, start the Compose stack with `ADMIN_EMAILS` configured, install Chromium with `npx --prefix frontend playwright install chromium`, then run `npm run test:e2e --prefix frontend`.

## Implemented flow and known gaps

- Product listing and product lookup, with integer-satang prices.
- Server-quoted pricing for PromptPay, TrueMoney, and card fees; discount caps; VAT; random checksum order IDs.
- Transactional single-SKU order creation, stock reservation, idempotency-key replay, and coupon reservation.
- Raw-body HMAC payment webhook verification, duplicate-event suppression, late-payment stock checks, persisted order events, and SSE across API replicas.
- A separate worker with retry/backoff, stale-job recovery, mock-game lookup-before-retry, a dead-letter state, and automatic-refund jobs for exhausted or unfulfillable work.
- Responsive Thai/English catalog, checkout, payment-simulation controls, checksum-validated tracking, SSE updates, metadata, sitemap/robots rules, and nonce-based CSP.
- Email OTP login with expiring, one-time codes, attempt/rate limits, opaque revocable sessions, HttpOnly cookies, and logout.
- Customer/admin role checks; admins can manage product price/stock/availability, inspect orders, and queue refunds with an audit trail.
- CSV settlement reconciliation against internal payment events, with matched/missing/mismatched rows persisted for review.
- Backend unit tests, Playwright browser E2E coverage, and a GitHub Actions workflow for the Compose stack.

This is not yet a complete submission for every item in `FULLSTACK_EXAM.pdf`. In particular, cart/multi-line order persistence, metrics, full OpenAPI coverage, database-backed state-transition constraints, expanded concurrency coverage, and design exports remain out of scope.

Configure at least one trusted admin mailbox in `ADMIN_EMAILS` before signing in. Removing an address from the allowlist revokes admin access on that user's next API request. Set `COOKIE_SECURE=true` when serving over HTTPS. For external SMTP, configure `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_SECURE`, and `MAIL_FROM`.

## Key files

- `backend/schema.sql`: PostgreSQL tables and seed data.
- `backend/server.js`: REST API and payment webhook.
- `backend/migrations/002_auth_admin_reconciliation.sql`: additive auth, audit, and reconciliation schema migration.
- `backend/auth.js`, `backend/reconciliation.js`: OTP/session primitives and settlement CSV parser/comparator.
- `backend/worker.js`: expiry and fulfillment worker.
- `backend/mock.js`: payment and game provider simulators.
- `docker-compose.yml`: local multi-service topology.
- `openapi.yaml`: implemented public API contract.
- `frontend/e2e/`: Playwright end-to-end scenarios.
- `.github/workflows/ci.yml`: lint, type-check, build, unit tests, and Compose-backed E2E.
- `ARCHITECTURE.md`, `RUNBOOK.md`, `docs/adr/`: design and operations notes.
=======
# InBlackM
>>>>>>> e5d93e1f662ac0eb4dec81270dfec9d0ddf067f7
