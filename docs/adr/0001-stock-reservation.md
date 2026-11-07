# ADR 0001: Reserve stock in the order transaction

- Status: Accepted
- Decision: Lock the product row with `SELECT ... FOR UPDATE`, validate available quantity, decrement finite stock, and insert the pending order in one PostgreSQL transaction.
- Rationale: Competing purchases serialize on the same product row. A failed insert rolls the reservation back, so limited stock is not oversold.
- Consequences: Unpaid orders temporarily reserve stock. The worker expires pending orders and restores their stock. Database row locking, not the UI, is the concurrency boundary.
- Limitation: Per-customer flash-sale limits across multiple active orders are not implemented yet.
