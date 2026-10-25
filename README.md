# Jungle Gaming Distributed Wagering Processor 🦧

A distributed financial service for high-concurrency wallet and wagering processing, built with NestJS, Bun 1.x, PostgreSQL, TypeORM and AWS SQS (LocalStack). 

The processor guarantees exact financial accuracy, persistent database idempotency, row-level concurrency control (`SELECT ... FOR UPDATE`), immutable ledger entries, and zero lost updates across multiple application instances.

---

## 1. Quick Start (Docker Compose)

The entire infrastructure (PostgreSQL 16, LocalStack SQS, application server and migrations) runs with a single command:

```sh
docker compose up --build
```

Services exposed:
- **API Server:** `http://localhost:3000`
- **Liveness probe:** `GET http://localhost:3000/health/live`
- **Readiness probe:** `GET http://localhost:3000/health/ready`
- **Prometheus metrics:** `GET http://localhost:3000/metrics`
- **PostgreSQL:** `localhost:5432` (`jungle` / `jungle`)
- **LocalStack SQS:** `http://localhost:4566`

To tear down the containers:
```sh
docker compose down -v
```

---

## 2. Local Development

Ensure Bun 1.x is installed:

```sh
bun install
bun run db:migrate
bun run start
```

Roll back migrations:
```sh
bun run db:revert
```

Type checking (strict mode):
```sh
bun run typecheck
```

---

## 3. Test Suites

### Unit Tests
Tests domain invariants for `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, and `IntegrationEvents`:

```sh
bun test test/domain.test.ts
```

### Integration & Concurrency Tests
Runs the full battery of tests against real PostgreSQL and LocalStack SQS containers (all 8 concurrency scenarios from Section 13):

```sh
# Via Docker Compose:
docker compose --profile test run --rm test

# Or from host (with Docker running):
$env:INTEGRATION="1"; $env:DATABASE_URL="postgres://jungle:jungle@localhost:5432/jungle"; $env:SQS_ENDPOINT="http://localhost:4566"; bun test
```

Tested scenarios:
1. **Mandatory Race Condition (Section 8):** Two simultaneous `BET` requests of BRL 80.00 against BRL 100.00. Exactly one succeeds (`PROCESSED`), the other is rejected (`REJECTED` with `INSUFFICIENT_FUNDS`), leaving final balance BRL 20.00 and exactly 1 debit ledger entry.
2. **50 Parallel Idempotent Bets (Section 13.1):** 50 concurrent requests with the same `Idempotency-Key` -> exactly 1 processed debit and 49 idempotent replays.
3. **Out-of-Order References (Section 13.7):** `REFUND` or `ROLLBACK` arriving before the referenced transaction -> enters `PENDING_REFERENCE`, retried with exponential backoff until the reference arrives and commits.
4. **Distinct Wallets in Parallel (Section 13.3):** Parallel operations across multiple independent wallets without cross-wallet lock contention.
5. **Multiple Application Instances (Section 13.4):** 3 concurrent `WagerService` instances concurrently mutating hot wallets with serialized row locks.
6. **Redelivery & Crash Recovery (Section 13.5):** SQS redelivering messages after commit (simulating worker crash before ack) -> deduplicated via persistent `message_inbox`.
7. **Concurrent Outbox Publishers (Section 13.6):** Two workers polling `message_outbox` with `FOR UPDATE SKIP LOCKED` without double delivery or lock contention.
8. **Schema Constraints & Triggers (Section 5.9):** Direct SQL mutation on ledger entries and terminal transactions are rejected by PostgreSQL triggers.
9. **Full Rollback Scenarios:** Rollback of `BET` (credits), `WIN` (debits), `REFUND` (debits), and rejection with `INSUFFICIENT_FUNDS_FOR_ROLLBACK` when balance is insufficient.

### Optional Differential: Load & Benchmark Test
Runs 500 concurrent operations across 10 hot wallets and reports throughput, p50/p95/p99 latency, error rates, outbox lag, and 100% financial reconciliation:

```sh
bun run test:load
```

---

## 4. HTTP API Reference

### Create Wallet
`POST /wallets`

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "currency": "BRL",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

Response (`201 Created` or `200 OK`):
```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

### Consult Wallet
`GET /wallets/:walletId`

### Ledger History (Opaque Keyset Cursor Pagination)
`GET /wallets/:walletId/ledger?limit=50&cursor=...`

Returns append-only audit entries and a stable `nextCursor` for paginating millions of rows efficiently.

### Submit Wagering Transaction
`POST /wagering/transactions`  
Headers: `Idempotency-Key: provider-a:transaction-123`

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

HTTP Status Codes:
- `200 OK`: Operation processed successfully (`PROCESSED`), or idempotent replay.
- `202 Accepted`: Asynchronous operation accepted or waiting for reference (`PENDING_REFERENCE`).
- `409 Conflict`: Idempotency key reused with divergent payload.
- `422 Unprocessable Entity`: Business rule rejection (e.g. `INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`).
- `503 Service Unavailable`: Transient infrastructure failure.

Response:
```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

### Consult Transaction
- Internal ID: `GET /wagering/transactions/:transactionId`
- Provider ID: `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

### Wallet Reconciliation
`POST /wallets/:walletId/reconciliation` (also `GET`)

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance":     { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42
}
```

---

## 5. Failure Codes Taxonomy

Every business rejection carries a stable, machine-readable `failureCode`:
- `INSUFFICIENT_FUNDS`: A `BET` exceeds the wallet's available balance.
- `INSUFFICIENT_FUNDS_FOR_ROLLBACK`: A `ROLLBACK` of a previous credit would push balance negative.
- `REFERENCE_NOT_FOUND`: Referenced transaction not found after exhausting retry attempts.
- `REFERENCE_NOT_PROCESSED`: Referenced transaction is in a non-terminal or failed state.
- `REFERENCE_MISMATCH`: Reference has mismatched provider, player, wallet, round, or currency.
- `INVALID_REFUND_REFERENCE`: `REFUND` referenced a non-`BET` transaction.
- `INVALID_ROLLBACK_REFERENCE`: `ROLLBACK` referenced an unsupported transaction type.
- `REFERENCE_AMOUNT_MISMATCH`: Reversal amount differs from the original transaction amount.
- `REFERENCE_ALREADY_REVERSED`: Target transaction was already reversed by this operation type.
- `CURRENCY_MISMATCH`: Transaction currency differs from wallet currency.
- `QUEUE_RETRY_EXHAUSTED`: Permanent infrastructure failure after max SQS redrives.

---

## 6. SQS Messaging Architecture

Queues:
- `wager-requests` & `wager-requests-dlq`: Entry point for asynchronous ingestion.
- `wager-events`: Integration events published by the transactional outbox:
  - `WagerTransactionProcessed`
  - `WagerTransactionRejected`
  - `WalletBalanceChanged` (emitted only when balance moves)
  - `WagerTransactionPendingReference`
  - `WagerTransactionFailed`
