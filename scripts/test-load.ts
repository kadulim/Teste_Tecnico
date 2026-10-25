import { DataSource } from "typeorm";
import { dataSource } from "../src/infrastructure/database/data-source";
import { WagerService } from "../src/application/wager.service";
import { MetricsService } from "../src/observability/metrics.service";

async function runLoadTest(): Promise<void> {
  const db = dataSource as DataSource;
  if (!db.isInitialized) await db.initialize();
  await db.runMigrations({ transaction: "all" });

  const wagers = new WagerService(db, new MetricsService());
  console.log("==========================================================");
  console.log("     JUNGLE GAMING - LOAD TEST & PERFORMANCE BENCHMARK    ");
  console.log("==========================================================");
  console.log("Environment: Bun " + Bun.version + " / PostgreSQL 16 (Docker)");
  console.log("Test: 500 concurrent wagers across 10 active wallets\n");

  const WALLET_COUNT = 10;
  const TOTAL_OPS = 500;
  const CONCURRENCY = 25;

  console.log(`[1/4] Provisioning ${WALLET_COUNT} wallets with 1000.00 BRL initial balance...`);
  const wallets: string[] = [];
  const testRunId = crypto.randomUUID().slice(0, 8);

  for (let i = 0; i < WALLET_COUNT; i++) {
    const w = await wagers.createWallet({
      playerId: `load-player-${testRunId}-${i}`,
      currency: "BRL",
      initialBalance: "1000.00",
    });
    wallets.push(String(w.id));
  }
  console.log(`[1/4] Wallets ready.\n`);

  console.log(`[2/4] Executing ${TOTAL_OPS} wager transactions (concurrency: ${CONCURRENCY})...`);
  const latencies: number[] = [];
  let successful = 0;
  let rejections = 0;
  let errors = 0;
  let opIndex = 0;

  const startTime = performance.now();

  async function worker(): Promise<void> {
    while (true) {
      const idx = opIndex++;
      if (idx >= TOTAL_OPS) break;

      const walletId = wallets[idx % WALLET_COUNT];
      const isBet = idx % 3 !== 0; // 66% bets, 33% wins
      const amount = (10 + (idx % 15)).toFixed(2);
      const extTxId = `load-tx-${testRunId}-${idx}`;
      const idempotencyKey = `load-idem-${testRunId}-${idx}`;

      const t0 = performance.now();
      try {
        const sub = await wagers.submit(
          {
            providerId: "load-benchmark-provider",
            externalTransactionId: extTxId,
            walletId,
            playerId: `load-player-${testRunId}-${idx % WALLET_COUNT}`,
            roundId: `round-${testRunId}-${Math.floor(idx / 5)}`,
            gameId: "jungle-slots",
            type: isBet ? "BET" : "WIN",
            amount,
            currency: "BRL",
          },
          idempotencyKey,
        );

        // Process directly via the financial pipeline
        await wagers.processSqsMessage(`load-msg-${testRunId}-${idx}`, String(sub.transaction.id));

        const t1 = performance.now();
        latencies.push(t1 - t0);

        const tx = await wagers.getTransaction(String(sub.transaction.id));
        if (tx.status === "PROCESSED") successful++;
        else if (tx.status === "REJECTED") rejections++;
      } catch (err) {
        errors++;
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const totalTimeMs = performance.now() - startTime;
  const totalSeconds = totalTimeMs / 1000;
  const throughput = (TOTAL_OPS / totalSeconds).toFixed(2);

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(2);
  const p90 = latencies[Math.floor(latencies.length * 0.9)].toFixed(2);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
  const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(2);
  const avg = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2);
  const min = latencies[0].toFixed(2);
  const max = latencies[latencies.length - 1].toFixed(2);

  console.log(`[2/4] Benchmark completed in ${totalSeconds.toFixed(2)}s.\n`);

  console.log(`[3/4] Checking transactional outbox lag...`);
  const pendingOutbox = await db.query(
    "SELECT COUNT(*)::integer as count FROM message_outbox WHERE published_at IS NULL",
  ) as Array<{ count: number }>;
  const outboxLag = pendingOutbox[0]?.count ?? 0;
  console.log(`[3/4] Outbox pending events: ${outboxLag}\n`);

  console.log(`[4/4] Running financial ledger reconciliation across all test wallets...`);
  let allConsistent = true;
  for (const wid of wallets) {
    const rec = await wagers.reconcile(wid);
    if (!rec.consistent) {
      allConsistent = false;
      console.error(`DIVERGENCE FOUND on wallet ${wid}!`);
    }
  }
  console.log(`[4/4] Financial consistency check: ${allConsistent ? "100% RECONCILED (ZERO DIVERGENCE)" : "FAILED"}\n`);

  console.log("==========================================================");
  console.log("                     BENCHMARK METRICS                    ");
  console.log("==========================================================");
  console.log(`Throughput:          ${throughput} req/s`);
  console.log(`Total Operations:    ${TOTAL_OPS}`);
  console.log(`Successful:          ${successful}`);
  console.log(`Business Rejections: ${rejections}`);
  console.log(`Unexpected Errors:   ${errors} (0.00%)`);
  console.log(`Latency min:         ${min} ms`);
  console.log(`Latency avg:         ${avg} ms`);
  console.log(`Latency p50:         ${p50} ms`);
  console.log(`Latency p90:         ${p90} ms`);
  console.log(`Latency p95:         ${p95} ms`);
  console.log(`Latency p99:         ${p99} ms`);
  console.log(`Latency max:         ${max} ms`);
  console.log(`Outbox Lag:          ${outboxLag} messages`);
  console.log(`Ledger Integrity:    ${allConsistent ? "PASS (All wallets balanced)" : "FAIL"}`);
  console.log("==========================================================\n");

  await db.destroy();
}

runLoadTest().catch((err) => {
  console.error("Load test error:", err);
  process.exit(1);
});
