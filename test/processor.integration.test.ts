import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { DataSource } from "typeorm";
import { WagerService } from "../src/application/wager.service";
import { dataSource } from "../src/infrastructure/database/data-source";
import { MetricsService } from "../src/observability/metrics.service";

if (process.env.INTEGRATION === "1") {
  describe("PostgreSQL and LocalStack integration", () => {
    let wagers: WagerService;
    const sqs = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });

    beforeAll(async () => {
      const db = dataSource as DataSource;
      if (!db.isInitialized) await db.initialize();
      await db.runMigrations({ transaction: "all" });
      wagers = new WagerService(db, new MetricsService());
    });

    afterAll(async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
      await sqs.destroy();
    });

    it("allows only one of two concurrent BRL 80 bets against BRL 100 and keeps ledger reconciled", async () => {
      const suffix = crypto.randomUUID();
      const wallet = await wagers.createWallet({
        playerId: `race-player-${suffix}`,
        currency: "BRL",
        initialBalance: "100.00",
      });
      const walletId = String(wallet.id);
      const base = {
        providerId: "integration-provider",
        walletId,
        playerId: String(wallet.playerId),
        roundId: `round-${suffix}`,
        gameId: "integration-game",
        type: "BET" as const,
        amount: "80.00",
        currency: "BRL",
      };
      const [left, right] = await Promise.all([
        wagers.submit({ ...base, externalTransactionId: `left-${suffix}` }, `left-key-${suffix}`),
        wagers.submit({ ...base, externalTransactionId: `right-${suffix}` }, `right-key-${suffix}`),
      ]);
      await Promise.all([
        wagers.processSqsMessage(`msg-left-${suffix}`, String(left.transaction.id)),
        wagers.processSqsMessage(`msg-right-${suffix}`, String(right.transaction.id)),
      ]);
      await wagers.processSqsMessage(`msg-left-${suffix}`, String(left.transaction.id));
      const final = await wagers.getWallet(walletId);
      const a = await wagers.getTransaction(String(left.transaction.id));
      const b = await wagers.getTransaction(String(right.transaction.id));
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
      expect((final.balance as { amount: string }).amount).toBe("20.00");
      const ledger = await wagers.getLedger(walletId, 100, 0);
      expect((ledger.items as unknown[]).length).toBe(2); // opening credit + one debit
      expect((await wagers.reconcile(walletId)).reconciled).toBe(true);
      const replayInput =
        a.status === "PROCESSED"
          ? { ...base, externalTransactionId: `left-${suffix}` }
          : { ...base, externalTransactionId: `right-${suffix}` };
      const replay = await wagers.submit(
        replayInput,
        a.status === "PROCESSED" ? `left-key-${suffix}` : `right-key-${suffix}`,
      );
      expect(replay.replayed).toBe(true);
      expect((replay.transaction.resultBalance as { amount: string }).amount).toBe("20.00");
    }, 30_000);

    it("waits for an out-of-order reference, applies one refund, and returns its stored result on replay", async () => {
      const suffix = crypto.randomUUID();
      const wallet = await wagers.createWallet({
        playerId: `reference-player-${suffix}`,
        currency: "BRL",
        initialBalance: "100.00",
      });
      const common = {
        providerId: "reference-provider",
        walletId: String(wallet.id),
        playerId: String(wallet.playerId),
        roundId: `reference-round-${suffix}`,
        gameId: "reference-game",
        currency: "BRL",
      };
      const refund = {
        ...common,
        externalTransactionId: `refund-${suffix}`,
        type: "REFUND" as const,
        amount: "30.00",
        referenceExternalTransactionId: `bet-${suffix}`,
      };
      const submittedRefund = await wagers.submit(refund, `refund-key-${suffix}`);
      await wagers.processSqsMessage(`refund-message-${suffix}`, String(submittedRefund.transaction.id));
      expect((await wagers.getTransaction(String(submittedRefund.transaction.id))).status).toBe(
        "PENDING_REFERENCE",
      );

      const bet = {
        ...common,
        externalTransactionId: `bet-${suffix}`,
        type: "BET" as const,
        amount: "30.00",
      };
      const submittedBet = await wagers.submit(bet, `bet-key-${suffix}`);
      await wagers.processSqsMessage(`bet-message-${suffix}`, String(submittedBet.transaction.id));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wagers.retryDueReferences();
        if ((await wagers.getTransaction(String(submittedRefund.transaction.id))).status === "PROCESSED") break;
        await Bun.sleep(250);
      }

      const processedRefund = await wagers.getTransaction(String(submittedRefund.transaction.id));
      expect(processedRefund.status).toBe("PROCESSED");
      expect((processedRefund.resultBalance as { amount: string }).amount).toBe("100.00");
      expect(((await wagers.getWallet(String(wallet.id))).balance as { amount: string }).amount).toBe("100.00");
      const replay = await wagers.submit(refund, `refund-key-${suffix}`);
      expect(replay.replayed).toBe(true);
      expect((replay.transaction.resultBalance as { amount: string }).amount).toBe("100.00");
      await expect(
        wagers.submit(
          {
            ...refund,
            externalTransactionId: `refund-again-${suffix}`,
          },
          `refund-again-key-${suffix}`,
        ),
      ).rejects.toThrow("reference already has a pending or completed reversal");
    }, 30_000);

    it("uses LocalStack SQS for persistent queue delivery", async () => {
      const name = `integration-${crypto.randomUUID()}`;
      const created = await sqs.send(new CreateQueueCommand({ QueueName: name }));
      const url = created.QueueUrl;
      expect(url).toBeTruthy();
      const sent = await sqs.send(new SendMessageCommand({ QueueUrl: url!, MessageBody: "round-trip" }));
      expect(sent.MessageId).toBeTruthy();
      const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url!, WaitTimeSeconds: 2 }));
      expect(received.Messages?.[0]?.Body).toBe("round-trip");
      if (received.Messages?.[0]?.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url!, ReceiptHandle: received.Messages[0].ReceiptHandle }));
      }
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url! }));
    }, 30_000);

    it("handles the same bet sent 50 times in parallel with a single debit and 49 idempotent replays", async () => {
      const suffix = crypto.randomUUID();
      const wallet = await wagers.createWallet({
        playerId: `player-50-${suffix}`,
        currency: "BRL",
        initialBalance: "100.00",
      });
      const walletId = String(wallet.id);
      const wagerInput = {
        providerId: "provider-50",
        externalTransactionId: `bet-50-${suffix}`,
        walletId,
        playerId: String(wallet.playerId),
        roundId: `round-50-${suffix}`,
        gameId: "game-50",
        type: "BET" as const,
        amount: "15.00",
        currency: "BRL",
      };
      const key = `key-50-${suffix}`;

      const results = await Promise.all(
        Array.from({ length: 50 }, () => wagers.submit(wagerInput, key)),
      );

      const newSubmissions = results.filter((r) => !r.replayed);
      const replays = results.filter((r) => r.replayed);
      expect(newSubmissions.length).toBe(1);
      expect(replays.length).toBe(49);

      const txId = newSubmissions[0].transactionId;
      await wagers.processSqsMessage(`msg-50-${suffix}`, txId);
      // Redeliver exact same message
      await wagers.processSqsMessage(`msg-50-${suffix}`, txId);

      const updatedWallet = await wagers.getWallet(walletId);
      expect((updatedWallet.balance as { amount: string }).amount).toBe("85.00");

      const ledger = await wagers.getLedger(walletId, 100, 0);
      expect((ledger.items as unknown[]).length).toBe(2);

      const reconciliation = await wagers.reconcile(walletId);
      expect(reconciliation.consistent).toBe(true);
      expect((reconciliation.difference as { amount: string }).amount).toBe("0.00");
    }, 30_000);

    it("processes distinct wallets in parallel without cross-wallet locking or interference", async () => {
      const count = 5;
      const wallets = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          wagers.createWallet({
            playerId: `parallel-p-${i}-${crypto.randomUUID()}`,
            currency: "BRL",
            initialBalance: "50.00",
          }),
        ),
      );

      await Promise.all(
        wallets.map(async (w) => {
          const wid = String(w.id);
          const pid = String(w.playerId);
          const s = crypto.randomUUID();

          const bet = await wagers.submit(
            {
              providerId: "parallel-prov",
              externalTransactionId: `b-${s}`,
              walletId: wid,
              playerId: pid,
              roundId: `r-${s}`,
              gameId: "g",
              type: "BET",
              amount: "10.00",
              currency: "BRL",
            },
            `k-b-${s}`,
          );
          await wagers.processSqsMessage(`m-b-${s}`, String(bet.transaction.id));

          const win = await wagers.submit(
            {
              providerId: "parallel-prov",
              externalTransactionId: `w-${s}`,
              walletId: wid,
              playerId: pid,
              roundId: `r-${s}`,
              gameId: "g",
              type: "WIN",
              amount: "20.00",
              currency: "BRL",
            },
            `k-w-${s}`,
          );
          await wagers.processSqsMessage(`m-w-${s}`, String(win.transaction.id));

          const finalWallet = await wagers.getWallet(wid);
          expect((finalWallet.balance as { amount: string }).amount).toBe("60.00");

          const rec = await wagers.reconcile(wid);
          expect(rec.consistent).toBe(true);
        }),
      );
    }, 30_000);

    it("handles >= 3 concurrent application instances with serialized wallet updates", async () => {
      const db = dataSource as DataSource;
      const instance1 = new WagerService(db, new MetricsService());
      const instance2 = new WagerService(db, new MetricsService());
      const instance3 = new WagerService(db, new MetricsService());

      const suffix = crypto.randomUUID();
      const wallet = await instance1.createWallet({
        playerId: `multi-inst-${suffix}`,
        currency: "BRL",
        initialBalance: "100.00",
      });
      const wid = String(wallet.id);
      const pid = String(wallet.playerId);

      const [sub1, sub2, sub3] = await Promise.all([
        instance1.submit(
          {
            providerId: "p",
            externalTransactionId: `i1-${suffix}`,
            walletId: wid,
            playerId: pid,
            roundId: `r-${suffix}`,
            gameId: "g",
            type: "BET",
            amount: "25.00",
            currency: "BRL",
          },
          `k1-${suffix}`,
        ),
        instance2.submit(
          {
            providerId: "p",
            externalTransactionId: `i2-${suffix}`,
            walletId: wid,
            playerId: pid,
            roundId: `r-${suffix}`,
            gameId: "g",
            type: "BET",
            amount: "25.00",
            currency: "BRL",
          },
          `k2-${suffix}`,
        ),
        instance3.submit(
          {
            providerId: "p",
            externalTransactionId: `i3-${suffix}`,
            walletId: wid,
            playerId: pid,
            roundId: `r-${suffix}`,
            gameId: "g",
            type: "BET",
            amount: "25.00",
            currency: "BRL",
          },
          `k3-${suffix}`,
        ),
      ]);

      await Promise.all([
        instance1.processSqsMessage(`m1-${suffix}`, String(sub1.transaction.id)),
        instance2.processSqsMessage(`m2-${suffix}`, String(sub2.transaction.id)),
        instance3.processSqsMessage(`m3-${suffix}`, String(sub3.transaction.id)),
      ]);

      const finalWallet = await instance1.getWallet(wid);
      expect((finalWallet.balance as { amount: string }).amount).toBe("25.00");
      const rec = await instance1.reconcile(wid);
      expect(rec.consistent).toBe(true);
    }, 30_000);

    it("deduplicates redelivered messages using persistent inbox (crash before ack)", async () => {
      const suffix = crypto.randomUUID();
      const wallet = await wagers.createWallet({
        playerId: `crash-${suffix}`,
        currency: "BRL",
        initialBalance: "100.00",
      });
      const wid = String(wallet.id);

      const sub = await wagers.submit(
        {
          providerId: "p-crash",
          externalTransactionId: `tx-crash-${suffix}`,
          walletId: wid,
          playerId: String(wallet.playerId),
          roundId: `r-${suffix}`,
          gameId: "g",
          type: "BET",
          amount: "40.00",
          currency: "BRL",
        },
        `k-crash-${suffix}`,
      );

      const msgId = `sqs-msg-${suffix}`;
      const txId = String(sub.transaction.id);

      await wagers.processSqsMessage(msgId, txId);
      const midBalance = await wagers.getWallet(wid);
      expect((midBalance.balance as { amount: string }).amount).toBe("60.00");

      // Redeliver exact same message
      await wagers.processSqsMessage(msgId, txId);
      await wagers.processSqsMessage(msgId, txId);

      const finalWallet = await wagers.getWallet(wid);
      expect((finalWallet.balance as { amount: string }).amount).toBe("60.00");

      const ledger = await wagers.getLedger(wid, 100, 0);
      expect((ledger.items as unknown[]).length).toBe(2);
      expect((await wagers.reconcile(wid)).consistent).toBe(true);
    }, 30_000);

    it("supports concurrent publishers over the same transactional outbox with SKIP LOCKED", async () => {
      const db = dataSource as DataSource;
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        await db.query(
          `INSERT INTO message_outbox (id, queue_name, event_type, aggregate_id, payload, created_at, next_attempt_at)
           VALUES ($1, 'events', 'WAGER_TEST', $2, '{"test":true}'::jsonb, now(), now())`,
          [id, crypto.randomUUID()],
        );
      }

      const publishWorker = async () => {
        return await db.transaction(async (em) => {
          const rows = (await em.query(
            `SELECT id FROM message_outbox WHERE id = ANY($1) AND published_at IS NULL FOR UPDATE SKIP LOCKED`,
            [ids],
          )) as Array<{ id: string }>;
          for (const row of rows) {
            await em.query(
              "UPDATE message_outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1",
              [row.id],
            );
          }
          return rows.map((r) => r.id);
        });
      };

      const [w1, w2] = await Promise.all([publishWorker(), publishWorker()]);
      const intersection = w1.filter((id) => w2.includes(id));
      expect(intersection.length).toBe(0);
      expect(w1.length + w2.length).toBe(10);
    }, 30_000);

    it("handles ROLLBACK reversing BET, WIN, and REFUND, rejecting when balance is insufficient", async () => {
      const suffix = crypto.randomUUID();
      const wallet = await wagers.createWallet({
        playerId: `rollback-${suffix}`,
        currency: "BRL",
        initialBalance: "50.00",
      });
      const wid = String(wallet.id);
      const pid = String(wallet.playerId);
      const common = {
        providerId: "p-rb",
        walletId: wid,
        playerId: pid,
        roundId: `r-${suffix}`,
        gameId: "g",
        currency: "BRL",
      };

      // 1. BET of 20.00 -> balance 30.00
      const bet = await wagers.submit(
        { ...common, externalTransactionId: `bet-${suffix}`, type: "BET", amount: "20.00" },
        `k-b-${suffix}`,
      );
      await wagers.processSqsMessage(`m-b-${suffix}`, String(bet.transaction.id));
      expect(((await wagers.getWallet(wid)).balance as { amount: string }).amount).toBe("30.00");

      // 2. ROLLBACK of BET -> inverts debit to credit (+20.00) -> balance 50.00
      const rbBet = await wagers.submit(
        {
          ...common,
          externalTransactionId: `rb-bet-${suffix}`,
          type: "ROLLBACK",
          amount: "20.00",
          referenceExternalTransactionId: `bet-${suffix}`,
        },
        `k-rb-b-${suffix}`,
      );
      await wagers.processSqsMessage(`m-rb-b-${suffix}`, String(rbBet.transaction.id));
      expect(((await wagers.getWallet(wid)).balance as { amount: string }).amount).toBe("50.00");

      // 3. WIN of 100.00 -> balance 150.00
      const win = await wagers.submit(
        { ...common, externalTransactionId: `win-${suffix}`, type: "WIN", amount: "100.00" },
        `k-w-${suffix}`,
      );
      await wagers.processSqsMessage(`m-w-${suffix}`, String(win.transaction.id));
      expect(((await wagers.getWallet(wid)).balance as { amount: string }).amount).toBe("150.00");

      // 4. ROLLBACK of WIN -> inverts credit to debit (-100.00) -> balance 50.00
      const rbWin = await wagers.submit(
        {
          ...common,
          externalTransactionId: `rb-win-${suffix}`,
          type: "ROLLBACK",
          amount: "100.00",
          referenceExternalTransactionId: `win-${suffix}`,
        },
        `k-rb-w-${suffix}`,
      );
      await wagers.processSqsMessage(`m-rb-w-${suffix}`, String(rbWin.transaction.id));
      expect(((await wagers.getWallet(wid)).balance as { amount: string }).amount).toBe("50.00");

      // 5. Test INSUFFICIENT_FUNDS_FOR_ROLLBACK:
      // WIN of 200.00 on round-2, then bet 240.00 -> balance 10.00
      const win2 = await wagers.submit(
        {
          ...common,
          roundId: `r2-${suffix}`,
          externalTransactionId: `win2-${suffix}`,
          type: "WIN",
          amount: "200.00",
        },
        `k-w2-${suffix}`,
      );
      await wagers.processSqsMessage(`m-w2-${suffix}`, String(win2.transaction.id));

      const bet2 = await wagers.submit(
        {
          ...common,
          roundId: `r2-${suffix}`,
          externalTransactionId: `bet2-${suffix}`,
          type: "BET",
          amount: "240.00",
        },
        `k-b2-${suffix}`,
      );
      await wagers.processSqsMessage(`m-b2-${suffix}`, String(bet2.transaction.id));
      expect(((await wagers.getWallet(wid)).balance as { amount: string }).amount).toBe("10.00");

      // ROLLBACK of win2 (200.00) against balance 10.00 -> REJECTED with INSUFFICIENT_FUNDS_FOR_ROLLBACK
      const rbWin2 = await wagers.submit(
        {
          ...common,
          roundId: `r2-${suffix}`,
          externalTransactionId: `rb-win2-${suffix}`,
          type: "ROLLBACK",
          amount: "200.00",
          referenceExternalTransactionId: `win2-${suffix}`,
        },
        `k-rb-w2-${suffix}`,
      );
      await wagers.processSqsMessage(`m-rb-w2-${suffix}`, String(rbWin2.transaction.id));
      const failedRb = await wagers.getTransaction(String(rbWin2.transaction.id));
      expect(failedRb.status).toBe("REJECTED");
      expect(failedRb.failureCode).toBe("INSUFFICIENT_FUNDS_FOR_ROLLBACK");

      // Balance remains 10.00, reconciled
      expect(((await wagers.getWallet(wid)).balance as { amount: string }).amount).toBe("10.00");
      expect((await wagers.reconcile(wid)).consistent).toBe(true);
    }, 30_000);

    it("enforces database schema constraints: immutable ledger and terminal wagers", async () => {
      const db = dataSource as DataSource;
      const suffix = crypto.randomUUID();
      const wallet = await wagers.createWallet({
        playerId: `trigger-${suffix}`,
        currency: "BRL",
        initialBalance: "100.00",
      });
      const wid = String(wallet.id);

      const sub = await wagers.submit(
        {
          providerId: "p-trg",
          externalTransactionId: `tx-trg-${suffix}`,
          walletId: wid,
          playerId: String(wallet.playerId),
          roundId: `r-${suffix}`,
          gameId: "g",
          type: "BET",
          amount: "10.00",
          currency: "BRL",
        },
        `k-trg-${suffix}`,
      );
      await wagers.processSqsMessage(`m-trg-${suffix}`, String(sub.transaction.id));

      // 1. Direct update on wallet_ledger_entries must be blocked by trigger
      await expect(
        db.query("UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = $1", [wid]),
      ).rejects.toThrow("wallet ledger entries are immutable");

      // 2. Direct delete on wallet_ledger_entries must be blocked by trigger
      await expect(
        db.query("DELETE FROM wallet_ledger_entries WHERE wallet_id = $1", [wid]),
      ).rejects.toThrow("wallet ledger entries are immutable");

      // 3. Direct transition on terminal wager must be blocked by trigger
      await expect(
        db.query("UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1", [sub.transaction.id]),
      ).rejects.toThrow("terminal wager transactions are immutable");

      expect((await wagers.reconcile(wid)).consistent).toBe(true);
    }, 30_000);

    it("supports cursor pagination on ledger and rejects idempotency key with divergent payload", async () => {
      const suffix = crypto.randomUUID();
      const wallet = await wagers.createWallet({
        playerId: `http-test-${suffix}`,
        currency: "BRL",
        initialBalance: "200.00",
      });
      const wid = String(wallet.id);
      const pid = String(wallet.playerId);

      for (let i = 1; i <= 3; i++) {
        const s = await wagers.submit(
          {
            providerId: "p-http",
            externalTransactionId: `tx-http-${i}-${suffix}`,
            walletId: wid,
            playerId: pid,
            roundId: `r-${suffix}`,
            gameId: "g",
            type: "BET",
            amount: "10.00",
            currency: "BRL",
          },
          `k-http-${i}-${suffix}`,
        );
        await wagers.processSqsMessage(`m-http-${i}-${suffix}`, String(s.transaction.id));
      }

      // Idempotency key conflict: reuse same key with DIFFERENT payload
      await expect(
        wagers.submit(
          {
            providerId: "p-http",
            externalTransactionId: `tx-divergent-${suffix}`,
            walletId: wid,
            playerId: pid,
            roundId: `r-${suffix}`,
            gameId: "g",
            type: "BET",
            amount: "99.00",
            currency: "BRL",
          },
          `k-http-1-${suffix}`,
        ),
      ).rejects.toThrow();

      // Test cursor pagination
      const page1 = await wagers.getLedger(wid, 2);
      expect((page1.items as unknown[]).length).toBe(2);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await wagers.getLedger(wid, 2, 0, page1.nextCursor as string);
      expect((page2.items as unknown[]).length).toBe(2);

      const rec = await wagers.reconcile(wid);
      expect(rec.consistent).toBe(true);
      expect(rec.checkedEntries).toBe(4);
    }, 30_000);
  });
}
