# ADR 0004: Handle payment success after order expiry

- Status: Accepted
- Decision: For a valid, amount-matching success event on an expired order, attempt to reserve stock again. If stock remains, transition to paid and enqueue fulfillment. Otherwise create an automatic refund job and move the order to `NEEDS_REVIEW`.
- Rationale: Never silently keep funds when the promised item cannot be supplied.
- Consequences: The refund job retries against the mock provider. Production payment-provider refund reconciliation and voucher reservation restoration still need implementation.
