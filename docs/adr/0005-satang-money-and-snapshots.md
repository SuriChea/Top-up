# ADR 0005: Integer satang and immutable order price snapshots

- Status: Accepted
- Decision: Store product and order amounts as PostgreSQL `BIGINT`, do intermediate percentage and fee calculations with JavaScript `BigInt`, and store the quoted unit price and totals on the order.
- Rationale: Integer arithmetic avoids floating-point rounding drift; order snapshots remain stable if a product's price changes later.
- Consequences: JSON API responses expose safe satang values as integers. Amounts beyond JavaScript's safe integer range are rejected before serialization.
