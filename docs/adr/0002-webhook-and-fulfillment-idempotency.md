# ADR 0002: Deduplicate webhooks and recover fulfillment ambiguity

- Status: Accepted
- Decision: Persist provider `event_id` under a unique constraint, and use the immutable order ID as the game top-up reference. Before retrying a game POST, the worker queries the provider's top-up status by that reference.
- Rationale: Event retries cannot reapply payment state, while a game operation that succeeded before a timeout can be observed before any retry POST.
- Consequences: A provider status lookup must be available to resolve ambiguous outcomes. Redis is not used as the durable idempotency store.
- Limitation: The local mock stores game top-ups in PostgreSQL. Real-provider retention and status consistency need contract testing.
