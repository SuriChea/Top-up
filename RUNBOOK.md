# Runbook

## Start the stack

Run `docker compose up --build` from the workspace root. Check `docker compose ps`, API readiness at <http://localhost:8080/readyz>, and the customer site at <http://localhost:3000>.

## API readiness fails

1. Inspect `docker compose logs postgres redis api-1 api-2`.
2. Wait for Postgres and Redis health checks; do not remove the data volumes to fix a transient outage.
3. If only one API replica is unhealthy, Nginx will continue serving through the other. Restore/rebuild the failed replica and confirm both `/readyz` endpoints.

## Fulfillment retries or dead-letter jobs

1. Query `fulfillment_jobs` joined to `orders` for `retry`/`dead` rows and inspect `last_error`, `attempts`, and the order event timeline.
2. Query the mock provider with `GET http://localhost:4002/topups/{order-id}` and inspect `GET http://localhost:4002/stats` before considering another delivery attempt.
3. Never issue a manual top-up until the provider confirms no successful top-up exists for the order reference.
4. A dead job creates an automatic refund job. Check `refund_jobs` and the order's final status; contact finance if the provider cannot confirm the refund.

## Settlement or payment mismatch

1. Sign in using an address in `ADMIN_EMAILS`, then upload the provider CSV at `/admin`.
2. Use the required columns `event_id,order_id,amount_satang,currency,type`; amounts must be integer satang and event types must be `payment.succeeded`, `payment.failed`, or `payment.refunded`.
3. Review the saved batch report. It identifies unknown orders, missing internal/provider events, event-type mismatches, and amount/currency mismatches.
4. Keep affected orders in their existing state until finance confirms the provider record. Do not edit an order amount to force a match.
5. Imports are append-only; each upload creates a batch. Upload corrected files as new batches so the audit history remains available.

## OTP and administrator access

- Add trusted administrator email addresses to `ADMIN_EMAILS`; users receive their role after a successful OTP login. Removing an address from the allowlist demotes the account and denies admin access on its next API request.
- OTP messages use the `MAIL_*` SMTP settings. In local Compose, inspect the Mailpit inbox at port 8025.
- OTPs expire after 10 minutes and allow five verification attempts. Requests are rate-limited by client IP and email.
- Sessions use a 12-hour HttpOnly, SameSite=Strict cookie. Set `COOKIE_SECURE=true` behind HTTPS. Rotate `AUTH_SECRET` and `TRACKING_TOKEN_SECRET` before deployment.
- Admin product updates, refund requests, and settlement imports are written to `admin_audit_logs`.
- Apply additive database changes with `npm run migrate --prefix backend`; API startup also applies the migration before accepting traffic.

## Mock game outage

Set `FAIL_RATE`, `TIMEOUT_RATE`, `SUCCESS_BUT_TIMEOUT_RATE`, and `LATENCY_MS` in `.env` only for local simulations. Once the service is healthy, queued retries resume automatically. Observe successful top-up counts before retrying or replaying jobs.
