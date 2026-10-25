import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException, Injectable, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { InsufficientFundsError } from "../domain/errors";
import { InboxMessage } from "../domain/inbox-message";
import { OutboxMessage } from "../domain/outbox-message";
import { Money, MoneyOverflowError } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { MetricsService } from "../observability/metrics.service";

export type ExternalWagerType = "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
export type WagerInputKind = ExternalWagerType | "OPENING";
export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind?: WagerInputKind;
  type?: WagerInputKind;
  money?: { amount: string; currency: string };
  amount?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}
export interface CreateWalletInput {
  playerId: string;
  currency?: string;
  initialBalance?: string | { amount: string; currency?: string };
}
interface TxRow {
  id: string; provider_id: string | null; external_transaction_id: string | null;
  idempotency_key: string | null; payload_hash: string; wallet_id: string; player_id: string;
  round_id: string; game_id: string; type: string; status: string; amount: string;
  currency: string; reference_external_transaction_id: string | null; ref_attempts: number;
  next_attempt_at: Date | null; created_at: Date; processed_at: Date | null;
  failure_code: string | null; result_balance: string | null;
}
interface WalletRow {
  id: string; player_id: string; currency: string; balance: string; version: number;
  created_at: Date; updated_at: Date;
}

function extractRows<T>(res: unknown): T[] {
  if (!res) return [];
  if (Array.isArray(res)) {
    if (res.length > 0 && Array.isArray(res[0])) {
      return res[0] as T[];
    }
    return res as T[];
  }
  return [res as T];
}

function extractRow<T>(res: unknown): T | undefined {
  const rows = extractRows<T>(res);
  return rows[0];
}

@Injectable()
export class WagerService {
  private readonly referenceMaxAttempts = Math.max(1, Number.parseInt(process.env.REFERENCE_MAX_ATTEMPTS ?? "8", 10));

  constructor(private readonly db: DataSource, private readonly metrics: MetricsService) {}

  async createWallet(input: CreateWalletInput): Promise<Record<string, unknown>> {
    const playerId = input.playerId?.trim();
    if (!playerId || playerId.length > 160) throw new UnprocessableEntityException("playerId is required (max 160 chars)");
    const currency = (typeof input.initialBalance === "object" && input.initialBalance?.currency)
      ? input.initialBalance.currency
      : (input.currency ?? "BRL");
    let initial: Money;
    if (typeof input.initialBalance === "object" && input.initialBalance !== null) {
      initial = Money.from(input.initialBalance.amount, currency);
    } else if (typeof input.initialBalance === "string") {
      initial = Money.from(input.initialBalance, currency);
    } else {
      initial = Money.zero(currency);
    }
    const id = randomUUID();
    try {
      return await this.db.transaction(async (em) => {
        const rows = await em.query(
          "INSERT INTO wallets (id, player_id, currency) VALUES ($1,$2,$3) RETURNING *",
          [id, playerId, currency],
        ) as WalletRow[];
        let wallet = Wallet.rehydrate({
          id, playerId, currency, balance: Money.zero(currency),
          version: 1, createdAt: rows[0].created_at, updatedAt: rows[0].updated_at,
        });
        if (initial.isPositive()) {
          const transactionId = randomUUID();
          await em.query(
            `INSERT INTO wager_transactions
              (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
               player_id, round_id, game_id, type, status, amount, currency, result_balance, processed_at)
             VALUES ($1,NULL,NULL,NULL,$2,$3,$4,'__opening__','__internal__','OPENING','PROCESSED',$5,$6,$5,now())`,
            [transactionId, createHash("sha256").update(`OPENING:${id}:${initial.toJSON().amount}`).digest("hex"), id, playerId, initial.toJSON().amount, currency],
          );
          const change = wallet.credit(transactionId, initial);
          const updatedRaw = await em.query(
            "UPDATE wallets SET balance=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING version,updated_at",
            [id, change.after.toJSON().amount],
          );
          const updatedRow = extractRow<{version: number; updated_at: Date}>(updatedRaw);
          await this.insertLedger(em, change.entry);
          wallet = Wallet.rehydrate({
            id, playerId, currency, balance: change.after,
            version: updatedRow?.version ?? 2, createdAt: rows[0].created_at, updatedAt: updatedRow?.updated_at ?? rows[0].updated_at,
          });
          await this.addOutbox(em, "events", "WAGER_PROCESSED", transactionId, {
            transactionId, walletId: id, type: "OPENING", status: "PROCESSED", ledgerEntryCreated: true,
          });
          await this.addOutbox(em, "events", "BALANCE_CHANGED", transactionId, {
            walletId: id, transactionId, balance: change.after.toJSON(), reason: "OPENING",
          });
        }
        return this.walletView(wallet, rows[0].created_at);
      });
    } catch (error) {
      if (this.sqlState(error) === "23505") throw new ConflictException("wallet already exists for player and currency");
      throw error;
    }
  }

  async getWallet(walletId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query("SELECT * FROM wallets WHERE id=$1", [walletId]) as WalletRow[];
    if (!rows[0]) throw new NotFoundException("wallet not found");
    return this.walletView(Wallet.rehydrate({
      id: rows[0].id, playerId: rows[0].player_id, currency: rows[0].currency,
      balance: Money.from(rows[0].balance, rows[0].currency), version: rows[0].version,
      createdAt: rows[0].created_at, updatedAt: rows[0].updated_at,
    }));
  }

  async getLedger(walletId: string, limit: number, offset: number = 0, cursor?: string): Promise<Record<string, unknown>> {
    const wallet = await this.db.query("SELECT id FROM wallets WHERE id=$1", [walletId]) as Array<{id: string}>;
    if (!wallet[0]) throw new NotFoundException("wallet not found");

    let query = `SELECT id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at
       FROM wallet_ledger_entries WHERE wallet_id=$1`;
    const params: unknown[] = [walletId];

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, "base64").toString("utf-8");
        const [cursorTime, cursorId] = decoded.split("#");
        if (cursorTime && cursorId) {
          query += ` AND (created_at, id) < ($${params.length + 1}, $${params.length + 2})`;
          params.push(new Date(cursorTime), cursorId);
        }
      } catch {}
    } else if (offset && offset > 0) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(offset);
    }

    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const rows = await this.db.query(query, params) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      id: row.id, walletId: row.wallet_id, transactionId: row.transaction_id,
      direction: row.direction, money: { amount: row.amount, currency: row.currency },
      balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency }, createdAt: row.created_at,
    }));

    let nextCursor: string | null = null;
    if (items.length === limit) {
      const last = items[items.length - 1];
      const token = `${new Date(last.createdAt as string | Date).toISOString()}#${last.id}`;
      nextCursor = Buffer.from(token).toString("base64");
    }

    return { items, limit, offset: offset ?? 0, cursor: cursor ?? null, nextCursor };
  }

  async submit(input: SubmitWagerInput, idempotencyKey: string): Promise<{
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string } | null;
    idempotentReplay: boolean;
    failureCode?: string | null;
    transaction: Record<string, unknown>;
    replayed: boolean;
  }> {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new UnprocessableEntityException("Idempotency-Key is required (max 200 chars)");
    const kind = input.kind ?? input.type;
    if (kind === "OPENING") throw new UnprocessableEntityException("OPENING is an internal transaction type");
    if (!kind) throw new UnprocessableEntityException("transaction kind is required");
    const currency = input.money?.currency ?? input.currency ?? "BRL";
    const amountStr = input.money?.amount ?? input.amount;
    if (!amountStr) throw new UnprocessableEntityException("amount is required");
    const money = Money.from(amountStr, currency);
    if (!money.isPositive()) throw new UnprocessableEntityException("amount must be greater than zero");
    if (!input.providerId?.trim() || !input.externalTransactionId?.trim() || !input.playerId?.trim() ||
        !input.walletId?.trim() || !input.roundId?.trim() || !input.gameId?.trim()) {
      throw new UnprocessableEntityException("provider, transaction, wallet, player, round and game identifiers are required");
    }
    if ((kind === "REFUND" || kind === "ROLLBACK") && !input.referenceExternalTransactionId?.trim()) {
      throw new UnprocessableEntityException("referenceExternalTransactionId is required for reversals");
    }
    const businessFields = {
      amount: money.toJSON().amount, currency, externalTransactionId: input.externalTransactionId,
      gameId: input.gameId, playerId: input.playerId, providerId: input.providerId,
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
      roundId: input.roundId, type: kind, walletId: input.walletId,
    };
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(businessFields).sort(([a], [b]) => a.localeCompare(b))));
    const payloadHash = createHash("sha256").update(canonical).digest("hex");

    const findReplay = async () => {
      const rows = await this.db.query(
        `SELECT * FROM wager_transactions WHERE wallet_id=$1 AND idempotency_key=$2
         UNION ALL
         SELECT * FROM wager_transactions WHERE provider_id=$3 AND external_transaction_id=$4
           AND NOT EXISTS (SELECT 1 FROM wager_transactions WHERE wallet_id=$1 AND idempotency_key=$2)
         LIMIT 1`,
        [input.walletId, key, input.providerId, input.externalTransactionId],
      ) as TxRow[];
      if (!rows[0]) return null;
      if (rows[0].payload_hash !== payloadHash) throw new ConflictException("idempotency key or provider transaction id was already used with a different payload");
      const txView = this.transactionView(rows[0]);
      return {
        transactionId: txView.id as string,
        status: txView.status as string,
        balance: (txView.resultBalance as { amount: string; currency: string } | null) ?? (txView.money as { amount: string; currency: string }),
        idempotentReplay: true,
        failureCode: (txView.failureCode as string) ?? null,
        transaction: txView,
        replayed: true,
      };
    };

    const existing = await findReplay();
    if (existing) return existing;
    try {
      const result = await this.db.transaction(async (em) => {
        const wallets = await em.query("SELECT * FROM wallets WHERE id=$1", [input.walletId]) as WalletRow[];
        if (!wallets[0]) throw new NotFoundException("wallet not found");
        if (wallets[0].player_id !== input.playerId) throw new ConflictException("wallet does not belong to playerId");
        if (wallets[0].currency !== currency) throw new ConflictException("wallet currency differs from transaction currency");
        const ids = await em.query(
          `INSERT INTO wager_transactions
            (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,type,status,amount,currency,reference_external_transaction_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12,$13)
           RETURNING id`,
          [randomUUID(), input.providerId, input.externalTransactionId, key, payloadHash, input.walletId,
            input.playerId, input.roundId, input.gameId, kind, money.toJSON().amount, currency,
            input.referenceExternalTransactionId ?? null],
        ) as Array<{id: string}>;
        const transactionId = ids[0].id;
        await this.addOutbox(em, "requests", "WAGER_REQUESTED", transactionId, { transactionId });
        const rows = await em.query("SELECT * FROM wager_transactions WHERE id=$1", [transactionId]) as TxRow[];
        const txView = this.transactionView(rows[0]);
        return {
          transactionId: txView.id as string,
          status: txView.status as string,
          balance: (txView.resultBalance as { amount: string; currency: string } | null) ?? (txView.money as { amount: string; currency: string }),
          idempotentReplay: false,
          failureCode: (txView.failureCode as string) ?? null,
          transaction: txView,
          replayed: false,
        };
      });
      this.metrics.submissions.inc();
      return result;
    } catch (error) {
      if (this.sqlState(error) === "23505") {
        const raced = await findReplay();
        if (raced) return raced;
        if (kind === "REFUND" || kind === "ROLLBACK") {
          const prior = await this.db.query(
            "SELECT id FROM wager_transactions WHERE provider_id=$1 AND reference_external_transaction_id=$2 AND type=$3 AND status IN ('PENDING','PENDING_REFERENCE','PROCESSED') LIMIT 1",
            [input.providerId, input.referenceExternalTransactionId, kind],
          ) as Array<{id: string}>;
          if (prior.length) throw new ConflictException("reference already has a pending or completed reversal of this type");
        }
      }
      throw error;
    }
  }

  async getTransaction(transactionId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query("SELECT * FROM wager_transactions WHERE id=$1", [transactionId]) as TxRow[];
    if (!rows[0]) throw new NotFoundException("transaction not found");
    return this.transactionView(rows[0]);
  }

  async getTransactionByExternal(providerId: string, externalTransactionId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query(
      "SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2",
      [providerId, externalTransactionId],
    ) as TxRow[];
    if (!rows[0]) throw new NotFoundException("transaction not found for provider");
    return this.transactionView(rows[0]);
  }

  async reconcile(walletId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query(
      `SELECT w.id,w.currency,w.balance,COALESCE(SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2) AS ledger_balance,
              (w.balance <> COALESCE(SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)) AS divergent,
              COUNT(l.id)::integer AS ledger_entries
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
       WHERE w.id=$1 GROUP BY w.id`,
      [walletId],
    ) as Array<{id: string; currency: string; balance: string; ledger_balance: string; divergent: boolean; ledger_entries: number}>;
    if (!rows[0]) throw new NotFoundException("wallet not found");
    const stored = Money.rehydrate(rows[0].balance, rows[0].currency);
    const calculated = Money.rehydrate(rows[0].ledger_balance, rows[0].currency);
    const diff = stored.subtract(calculated);
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: diff.toJSON(),
      consistent: !rows[0].divergent,
      checkedEntries: rows[0].ledger_entries,
      currency: rows[0].currency,
      walletBalance: rows[0].balance,
      ledgerBalance: rows[0].ledger_balance,
      ledgerEntries: rows[0].ledger_entries,
      reconciled: !rows[0].divergent,
    };
  }

  async processSqsMessage(messageId: string, transactionId: string): Promise<void> {
    await this.db.transaction(async (em) => {
      const inboxRecord = InboxMessage.create("wager-processor", messageId);
      const received = await em.query(
        "INSERT INTO message_inbox (consumer_name,message_id,received_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id",
        [inboxRecord.consumerName, inboxRecord.messageId, inboxRecord.receivedAt],
      ) as Array<{message_id: string}>;
      const receivedRows = extractRows(received);
      if (!receivedRows.length) return;
      await this.processLocked(em, transactionId, false);
    });
    this.metrics.messagesProcessed.inc();
  }

  async failRedrivenMessage(messageId: string, transactionId: string): Promise<void> {
    await this.db.transaction(async (em) => {
      const inboxRecord = InboxMessage.create("wager-processor", messageId);
      const inbox = await em.query(
        "INSERT INTO message_inbox (consumer_name,message_id,received_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id",
        [inboxRecord.consumerName, inboxRecord.messageId, inboxRecord.receivedAt],
      ) as Array<{message_id: string}>;
      const inboxRows = extractRows(inbox);
      if (!inboxRows.length) return;
      const initial = await em.query("SELECT wallet_id FROM wager_transactions WHERE id=$1", [transactionId]) as Array<{wallet_id: string}>;
      if (!initial[0]) {
        this.log("error", "dead_letter_transaction_missing", { transactionId, messageId });
        return;
      }
      const wallets = await em.query("SELECT * FROM wallets WHERE id=$1 FOR UPDATE", [initial[0].wallet_id]) as WalletRow[];
      const txs = await em.query("SELECT * FROM wager_transactions WHERE id=$1 FOR UPDATE", [transactionId]) as TxRow[];
      const tx = txs[0];
      if (!wallets[0] || !tx || (tx.status !== "PENDING" && tx.status !== "PENDING_REFERENCE")) return;
      const balance = Money.from(wallets[0].balance, wallets[0].currency);
      await em.query(
        "UPDATE wager_transactions SET status='FAILED',processed_at=now(),failure_code='SQS_RETRY_EXHAUSTED',result_balance=$2,next_attempt_at=NULL WHERE id=$1",
        [tx.id, balance.toJSON().amount],
      );
      await this.addOutbox(em, "events", "WAGER_FAILED", tx.id, {
        transactionId: tx.id, walletId: tx.wallet_id, type: tx.type,
        failureCode: "SQS_RETRY_EXHAUSTED", balance: balance.toJSON(),
      });
    });
    this.metrics.results.inc({ status: "failed" });
  }

  async retryDueReferences(): Promise<void> {
    const due = await this.db.query(
      "SELECT id FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 100",
    ) as Array<{id: string}>;
    for (const row of due) {
      try {
        await this.db.transaction((em) => this.processLocked(em, row.id, true));
      } catch (error) {
        this.log("error", "reference_retry_failed", { transactionId: row.id, error: String(error) });
      }
    }
  }

  private async processLocked(em: EntityManager, transactionId: string, referenceRetry: boolean): Promise<void> {
    const initial = await em.query("SELECT wallet_id FROM wager_transactions WHERE id=$1", [transactionId]) as Array<{wallet_id: string}>;
    if (!initial[0]) {
      this.log("error", "queue_transaction_missing", { transactionId });
      return;
    }
    const wallets = await em.query("SELECT * FROM wallets WHERE id=$1 FOR UPDATE", [initial[0].wallet_id]) as WalletRow[];
    const txs = await em.query("SELECT * FROM wager_transactions WHERE id=$1 FOR UPDATE", [transactionId]) as TxRow[];
    const tx = txs[0];
    if (!wallets[0] || !tx || (tx.status !== "PENDING" && tx.status !== "PENDING_REFERENCE")) return;
    if (referenceRetry && tx.status === "PENDING_REFERENCE" && tx.next_attempt_at && new Date(tx.next_attempt_at).getTime() > Date.now()) return;
    const walletRow = wallets[0];
    const balance = Money.from(walletRow.balance, walletRow.currency);
    if (tx.currency !== walletRow.currency) {
      await this.reject(em, tx, balance, "CURRENCY_MISMATCH");
      return;
    }

    let original: TxRow | null = null;
    let direction: "DEBIT" | "CREDIT" | null = null;
    if (tx.type === "REFUND" || tx.type === "ROLLBACK") {
      const refs = await em.query(
        "SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2",
        [tx.provider_id, tx.reference_external_transaction_id],
      ) as TxRow[];
      original = refs[0] ?? null;
      if (!original || original.status === "PENDING" || original.status === "PENDING_REFERENCE") {
        await this.deferReference(em, tx, balance, referenceRetry);
        return;
      }
      const mismatch = original.provider_id !== tx.provider_id || original.player_id !== tx.player_id ||
        original.wallet_id !== tx.wallet_id || original.currency !== tx.currency ||
        original.round_id !== tx.round_id;
      if (mismatch) { await this.reject(em, tx, balance, "REFERENCE_MISMATCH"); return; }
      if (original.status !== "PROCESSED") { await this.reject(em, tx, balance, "REFERENCE_NOT_PROCESSED"); return; }
      if (original.type !== "BET" && tx.type === "REFUND") {
        await this.reject(em, tx, balance, "INVALID_REFUND_REFERENCE"); return;
      }
      if (tx.type === "ROLLBACK" && !["BET", "WIN", "REFUND"].includes(original.type)) {
        await this.reject(em, tx, balance, "INVALID_ROLLBACK_REFERENCE"); return;
      }
      if (!Money.from(tx.amount, tx.currency).equals(Money.from(original.amount, original.currency))) {
        await this.reject(em, tx, balance, "REFERENCE_AMOUNT_MISMATCH"); return;
      }
      const prior = await em.query(
        "SELECT id FROM wager_transactions WHERE provider_id=$1 AND reference_external_transaction_id=$2 AND type=$3 AND id<>$4 AND status IN ('PENDING','PENDING_REFERENCE','PROCESSED') LIMIT 1",
        [tx.provider_id, tx.reference_external_transaction_id, tx.type, tx.id],
      ) as Array<{id: string}>;
      if (prior.length) { await this.reject(em, tx, balance, "REFERENCE_ALREADY_REVERSED"); return; }

      if (tx.type === "REFUND") {
        direction = "CREDIT";
      } else if (tx.type === "ROLLBACK") {
        if (original.type === "BET") direction = "CREDIT";
        else if (original.type === "WIN" || original.type === "REFUND") direction = "DEBIT";
      }
    }
    if (tx.type === "BET") direction = "DEBIT";
    else if (tx.type === "WIN") direction = "CREDIT";

    const money = Money.from(tx.amount, tx.currency);
    let after = balance;
    if (direction) {
      const wallet = Wallet.rehydrate({
        id: walletRow.id, playerId: walletRow.player_id, currency: walletRow.currency,
        balance, version: walletRow.version, createdAt: walletRow.created_at, updatedAt: walletRow.updated_at,
      });
      try {
        const change = direction === "CREDIT" ? wallet.credit(tx.id, money) : wallet.debit(tx.id, money);
        after = change.after;
        await em.query(
          "UPDATE wallets SET balance=$2,version=version+1,updated_at=now() WHERE id=$1",
          [walletRow.id, after.toJSON().amount],
        );
        await this.insertLedger(em, change.entry);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          await this.reject(em, tx, balance, tx.type === "BET" ? "INSUFFICIENT_FUNDS" : "INSUFFICIENT_FUNDS_FOR_ROLLBACK");
          return;
        }
        if (error instanceof MoneyOverflowError) {
          await this.reject(em, tx, balance, "WALLET_BALANCE_LIMIT_EXCEEDED");
          return;
        }
        throw error;
      }
    }

    await em.query(
      "UPDATE wager_transactions SET status='PROCESSED',processed_at=now(),failure_code=NULL,result_balance=$2,next_attempt_at=NULL WHERE id=$1",
      [tx.id, after.toJSON().amount],
    );
    await this.addOutbox(em, "events", "WAGER_PROCESSED", tx.id, {
      transactionId: tx.id, walletId: tx.wallet_id, type: tx.type, status: "PROCESSED",
      balance: after.toJSON(), ledgerEntryCreated: direction !== null,
    });
    this.metrics.results.inc({ status: "processed" });
    if (direction) await this.addOutbox(em, "events", "BALANCE_CHANGED", tx.id, {
      walletId: tx.wallet_id, transactionId: tx.id, balance: after.toJSON(), reason: tx.type,
    });
  }

  private async deferReference(em: EntityManager, tx: TxRow, balance: Money, isRetry: boolean): Promise<void> {
    const attempts = tx.ref_attempts + (isRetry ? 1 : 0);
    if (isRetry && attempts >= this.referenceMaxAttempts) {
      await this.reject(em, tx, balance, "REFERENCE_NOT_FOUND");
      return;
    }
    const delaySeconds = isRetry ? Math.min(60, 2 ** Math.min(attempts, 6)) : 1;
    await em.query(
      "UPDATE wager_transactions SET status='PENDING_REFERENCE',ref_attempts=$2,next_attempt_at=now()+($3 * interval '1 second') WHERE id=$1",
      [tx.id, attempts, delaySeconds],
    );
    await this.addOutbox(em, "events", "WAGER_PENDING_REFERENCE", tx.id, {
      transactionId: tx.id, providerId: tx.provider_id,
      referenceExternalTransactionId: tx.reference_external_transaction_id, attempts,
    });
  }

  private async reject(em: EntityManager, tx: TxRow, balance: Money, code: string): Promise<void> {
    await em.query(
      "UPDATE wager_transactions SET status='REJECTED',processed_at=now(),failure_code=$2,result_balance=$3,next_attempt_at=NULL WHERE id=$1",
      [tx.id, code, balance.toJSON().amount],
    );
    await this.addOutbox(em, "events", "WAGER_REJECTED", tx.id, {
      transactionId: tx.id, walletId: tx.wallet_id, type: tx.type, failureCode: code,
      balance: balance.toJSON(),
    });
    this.metrics.results.inc({ status: "rejected" });
  }

  private async insertLedger(em: EntityManager, entry: import("../domain/ledger-entry").WalletLedgerEntry): Promise<void> {
    await em.query(
      `INSERT INTO wallet_ledger_entries
       (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.toJSON().amount,
        entry.money.currency, entry.balanceBefore.toJSON().amount, entry.balanceAfter.toJSON().amount, entry.createdAt],
    );
  }

  private async addOutbox(
    em: EntityManager, queue: "requests" | "events", type: string, aggregateId: string, payload: unknown,
  ): Promise<void> {
    const message = OutboxMessage.create(queue, type, aggregateId, payload);
    await em.query(
      "INSERT INTO message_outbox (id,queue_name,event_type,aggregate_id,payload,created_at,next_attempt_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)",
      [message.id, message.queueName, message.eventType, message.aggregateId, JSON.stringify(message.payload), message.createdAt],
    );
  }

  private walletView(wallet: Wallet, createdAt?: Date): Record<string, unknown> {
    return {
      id: wallet.id, playerId: wallet.playerId, currency: wallet.currency, balance: wallet.balance.toJSON(),
      version: wallet.version, createdAt: createdAt ?? wallet.createdAt, updatedAt: wallet.updatedAt,
    };
  }

  private transactionView(row: TxRow): Record<string, unknown> {
    return {
      id: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, walletId: row.wallet_id,
      playerId: row.player_id, roundId: row.round_id, gameId: row.game_id, type: row.type,
      kind: row.type, status: row.status, money: { amount: row.amount, currency: row.currency },
      referenceExternalTransactionId: row.reference_external_transaction_id,
      createdAt: row.created_at, processedAt: row.processed_at, failureCode: row.failure_code,
      resultBalance: row.result_balance === null ? null : { amount: row.result_balance, currency: row.currency },
    };
  }

  private sqlState(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "driverError" in error) {
      const driver = (error as {driverError?: {code?: string}}).driverError;
      return driver?.code;
    }
    if (typeof error === "object" && error !== null && "code" in error) return (error as {code?: string}).code;
    return undefined;
  }

  private log(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
    console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
  }
}
