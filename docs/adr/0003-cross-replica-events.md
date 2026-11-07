# ADR 0003: Redis pub/sub for cross-replica live events

- Status: Accepted
- Decision: Commit order events to PostgreSQL first, then publish their IDs and payloads to a Redis channel keyed by order ID. SSE subscribes before replaying database events and deduplicates by event ID.
- Rationale: Either API replica can serve tracking while another handles the webhook or worker event. The database is the replay source after reconnect.
- Consequences: Pub/sub is transient; clients reconnect with `Last-Event-ID` and replay from the append-only event table. Redis availability is required for ready status and live delivery.
