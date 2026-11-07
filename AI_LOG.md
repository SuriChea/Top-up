# AI usage log

AI assistance was used to inspect the supplied requirements, draft the API/domain implementation, create the storefront and simulator UI, and draft the operational documentation. The implementer should review and run the code before relying on it.

## Issues caught during review and corrected

1. The first SSE implementation subscribed to Redis after querying event history, leaving a gap where an event could be lost. The listener now subscribes first, buffers live events while replaying the database, and deduplicates by the event ID.
2. The first tracking-link approach placed the bearer token in the URL, where it could be retained in access logs and browser history. The UI now sends the token in an Authorization header.
3. A failed fulfillment retry initially changed the order back to the queue without recording that transition. The worker now appends and publishes an order event when it schedules a retry.

## Scope note

This log records AI-assisted code generation and review. It is not evidence that the full exam requirements or security properties have passed independent verification. Known incomplete requirements are listed in `README.md`.
