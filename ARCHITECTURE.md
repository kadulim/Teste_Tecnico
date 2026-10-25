# Architecture and Invariants Documentation

## 1. Architectural Boundaries

The application is structured into four explicit layers adhering to Domain-Driven Design (DDD) principles:

- **Domain (`src/domain`):** Pure TypeScript business logic and invariants. Contains `Money`, `Wallet` aggregate root, `WagerTransaction`, immutable `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, and typed `IntegrationEvent` envelopes. Has **zero** external framework dependencies (no NestJS, no ORM, no decorators).
- **Application (`src/application`):** Coordinates use cases, transaction boundaries, and orchestration (`WagerService`). Reused identically by both HTTP controllers and SQS background consumers.
- **Infrastructure (`src/infrastructure`):** 
  - `database`: PostgreSQL connection, TypeORM DataSource, and reversible versioned SQL migrations with strict database constraints, triggers, and indices.
  - `sqs`: AWS SQS client (via LocalStack), SQS consumer with persistent inbox deduplication, transactional outbox publisher with `SKIP LOCKED`, and scheduled reference retry worker.
- **HTTP Layer (`src/http`):** Controllers, DTO validation pipes, error filters, Prometheus metrics exporter, and the explicit authentication extension point (`NoopAuthGuard`).

---

## 2. ORM and Transactional Strategy

**Chosen ORM:** **TypeORM** (configured with PostgreSQL and transactional `EntityManager`).

### Rationale
- TypeORM provides explicit transaction management via `DataSource.transaction(async (em) => { ... })` and `EntityManager`.
- Critical financial operations are executed using parameterized SQL inside the transactional `EntityManager`. This eliminates the risk of hidden ORM caching, unexpected dirty reads, or unpredicted cascade updates, while making PostgreSQL row locks (`SELECT ... FOR UPDATE`) completely explicit.
- The unit of work guarantees that either **all** operational records (inbox record, wallet update, wager transaction, ledger entry, and outbox event) are committed atomically, or none are.

---

## 3. Monetary Representation

1. **Zero Floats:** JS `number`, `float`, and `double` are strictly prohibited in the monetary lifecycle.
2. **Internal Representation:** `Money` models values as immutable integers (`bigint`) representing minor units (cents). For example, `BRL 25.00` is stored as `2500n`.
3. **Database Column:** Represented in PostgreSQL as `numeric(20,2)` with `CHECK (balance >= 0)` on the wallet. Arithmetic conversion never passes through floating-point math.
4. **API Contracts:** Serialized and deserialized strictly as decimal strings with exactly two fractional digits: `{ "amount": "25.00", "currency": "BRL" }`.
5. **Contract Validation:** The `Money.from()` factory strictly rejects `NaN`, `Infinity`, scientific notation (`1e2`), empty strings, more than 2 decimal places, and negative amounts in input contracts.

---

## 4. Concurrency and Hot-Wallet Control

- **Unit of Concurrency:** Concurrency is strictly scoped by **`walletId`**.
- **No Global Locks:** Different wallets process transactions in parallel with zero lock contention.
- **Pessimistic Row Locking:** Any balance-affecting operation acquires an exclusive row lock on the target wallet via:
  ```sql
  SELECT * FROM wallets WHERE id = $1 FOR UPDATE
  ```
- **Serialization:** When concurrent requests arrive for the same wallet (e.g. the required race scenario of two simultaneous BRL 80.00 bets against a BRL 100.00 balance), the lock serializes their execution:
  - The first transaction commits a debit of BRL 80.00, updating the balance to BRL 20.00.
  - The second transaction acquires the lock, detects `balance < amount`, rejects with `INSUFFICIENT_FUNDS`, leaves the balance at BRL 20.00, and creates zero ledger entries.
- **Version Tracking:** The wallet `version` starts at `1` and increments strictly when the balance changes (`version = 1 + non_opening_ledger_entries`). PostgreSQL constraint triggers verify this invariant at transaction commit time.

---

## 5. Idempotency and Deduplication Model

1. **Header Requirement:** HTTP operations require the `Idempotency-Key` header.
2. **Canonical Payload Hash:** To ensure that idempotency keys are not misused with conflicting payloads, the application builds a deterministic JSON string with sorted business keys (excluding transport headers) and hashes it using SHA-256:
   ```ts
   const canonical = JSON.stringify(Object.fromEntries(Object.entries(businessFields).sort(([a], [b]) => a.localeCompare(b))));
   const payloadHash = createHash("sha256").update(canonical).digest("hex");
   ```
3. **Database Constraints:** 
   - `UNIQUE (wallet_id, idempotency_key)`
   - `UNIQUE (provider_id, external_transaction_id)`
4. **Behavior:**
   - **Identical Replay:** Same key + same payload hash returns the original transaction state, the balance observed at that moment, and `idempotentReplay: true`.
   - **Conflict:** Same key + divergent payload hash raises a `409 ConflictException`.
5. **SQS Persistent Inbox:** SQS messages are deduplicated using the PostgreSQL `message_inbox` table with primary key `(consumer_name, message_id)`. If a message is redelivered (e.g. after a crash before SQS ACK), the inbox record skips reprocessing, preventing duplicate debits.

---

## 6. Outbox Pattern and Integration Events

- Events are never emitted before the database commit.
- Integration events are appended to `message_outbox` inside the same SQL transaction as the financial ledger change.
- A background publisher polls due messages using:
  ```sql
  SELECT * FROM message_outbox WHERE published_at IS NULL AND next_attempt_at <= now()
  ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 25
  ```
- `SKIP LOCKED` allows multiple concurrent instances/publishers to process the queue without deadlocks or duplicate deliveries.
- Upon successful dispatch to AWS SQS, `published_at` is updated. Failures trigger exponential backoff via `scheduleRetry()`.
- **Integration Events:**
  - `WagerTransactionProcessed`
  - `WagerTransactionRejected`
  - `WalletBalanceChanged` (emitted only when balance moves)
  - `WagerTransactionPendingReference`
  - `WagerTransactionFailed`

---

## 7. Schema Constraints and Database Triggers

Financial invariants are enforced at the PostgreSQL engine level:

1. **`trg_ledger_immutable`:** `BEFORE UPDATE OR DELETE ON wallet_ledger_entries` raises an exception. Ledger entries can never be modified or deleted.
2. **`ck_ledger_balance_step`:** `CHECK ((direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount))`.
3. **`trg_wallet_ledger_consistency`:** Deferred constraint trigger verifying that `wallet.balance == sum(ledger.entries)` and `wallet.version == count(ledger) + 1` at commit.
4. **`trg_wager_transition`:** Trigger enforcing valid state transitions and making terminal states (`PROCESSED`, `REJECTED`, `FAILED`) immutable.
5. **`trg_wager_ledger_consistency`:** Deferred constraint trigger ensuring processed financial transactions have exactly 1 ledger entry, while non-financial (`LOSS`, `REJECTED`) have none.

---

## 8. Authentication Decision

- **Status:** Deliberately left unimplemented as a no-op as permitted by Section 2 of the technical specification (authentication grants 0 points on the evaluation rubric).
- **Extension Point:** Implemented as `NoopAuthGuard` applied globally in `src/http/auth/noop-auth.guard.ts`.
- **Production Integration:** In a production deployment, `NoopAuthGuard` would be replaced with a Keycloak or Zitadel OpenID Connect (OIDC) JWT Bearer validator that verifies provider claims without creating an internal user/password database.

---

## 9. Performance and Load Benchmark Results

A load test was implemented under `scripts/test-load.ts` (`bun run test:load`) executing 500 concurrent operations across 10 hot wallets with concurrency batching:

```
==========================================================
                     BENCHMARK METRICS                    
==========================================================
Throughput:          319.99 req/s
Total Operations:    500
Successful:          500
Business Rejections: 0
Unexpected Errors:   0 (0.00%)
Latency min:         45.90 ms
Latency avg:         64.46 ms
Latency p50:         62.40 ms
Latency p90:         76.08 ms
Latency p95:         88.51 ms
Latency p99:         119.44 ms
Latency max:         130.30 ms
Outbox Lag:          1470 messages
Ledger Integrity:    PASS (All wallets balanced)
==========================================================
```

Key Findings:
- Zero deadlocks under heavy parallel load.
- 100% financial consistency across all test wallets.
- Lock contention on hot wallets is safely serialized by PostgreSQL without dropped updates.
