import { describe, expect, it } from "bun:test";
import { WalletLedgerEntry } from "../src/domain/ledger-entry";
import { InboxMessage, InboxRecord } from "../src/domain/inbox-record";
import { Money } from "../src/domain/money";
import { OutboxMessage } from "../src/domain/outbox-message";
import { Wallet } from "../src/domain/wallet";
import { WagerTransaction } from "../src/domain/wager-transaction";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "../src/domain/integration-events";
import { InvalidTransactionStateError, InvalidWagerError, CurrencyMismatchError } from "../src/domain/errors";

describe("Money", () => {
  it("uses exact minor units and immutable arithmetic", () => {
    const a = Money.from("0.10", "BRL");
    const b = Money.from("0.20", "BRL");
    expect(a.add(b).toJSON()).toEqual({ amount: "0.30", currency: "BRL" });
    expect(Money.from("1.00", "BRL").subtract(Money.from("1.01", "BRL")).toJSON().amount).toBe("-0.01");
    expect(a.negate().toJSON().amount).toBe("-0.10");
  });

  it("exposes comparison, query, and string serialization methods", () => {
    const zero = Money.zero("BRL");
    const pos = Money.from("50.00", "BRL");
    const neg = pos.negate();

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);

    expect(pos.isPositive()).toBe(true);
    expect(pos.isNegative()).toBe(false);
    expect(pos.isZero()).toBe(false);

    expect(neg.isNegative()).toBe(true);
    expect(neg.isPositive()).toBe(false);

    expect(zero.isLessThan(pos)).toBe(true);
    expect(pos.isLessThan(zero)).toBe(false);
    expect(pos.equals(Money.from("50.00", "BRL"))).toBe(true);
    expect(pos.equals(zero)).toBe(false);

    expect(pos.toString()).toBe("BRL 50.00");
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  it("rehydrates signed amounts for derived or persisted values", () => {
    const rehydrated = Money.rehydrate("-15.50", "BRL");
    expect(rehydrated.toJSON()).toEqual({ amount: "-15.50", currency: "BRL" });
    expect(rehydrated.isNegative()).toBe(true);
  });

  it("rejects malformed, negative, scientific and over-scale input", () => {
    for (const value of ["", "-1.00", "1", "1.0", "1.001", "1e2", "NaN", "Infinity", "abc"]) {
      expect(() => Money.from(value, "BRL")).toThrow();
    }
    expect(() => Money.from("1.00", "brl")).toThrow();
    expect(() => Money.from("999999999999999999.99", "BRL").add(Money.from("0.01", "BRL"))).toThrow();
  });

  it("rejects currency conflicts", () => {
    expect(() => Money.from("1.00", "BRL").add(Money.from("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(() => Money.from("1.00", "BRL").subtract(Money.from("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(() => Money.from("1.00", "BRL").isLessThan(Money.from("1.00", "USD"))).toThrow(CurrencyMismatchError);
  });
});

describe("Wallet", () => {
  it("credits and debits with a version change only when balance changes", () => {
    const wallet = Wallet.create("player-1", "BRL");
    expect(wallet.version).toBe(1);
    wallet.credit("tx-credit", Money.from("100.00", "BRL"));
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(2);
    wallet.debit("tx-debit", Money.from("80.00", "BRL"));
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(3);
  });

  it("supports open() with initial balance generating an openingEntry", () => {
    const wallet = Wallet.open({
      playerId: "player-init",
      initialBalance: Money.from("500.00", "BRL"),
    });
    expect(wallet.balance.toJSON().amount).toBe("500.00");
    expect(wallet.version).toBe(1);

    const entry = wallet.openingEntry("tx-opening");
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe("CREDIT");
    expect(entry!.money.toJSON().amount).toBe("500.00");
    expect(entry!.balanceBefore.toJSON().amount).toBe("0.00");
    expect(entry!.balanceAfter.toJSON().amount).toBe("500.00");

    // Second call returns null since pendingOpening was consumed
    expect(wallet.openingEntry("tx-opening-2")).toBeNull();
  });

  it("does not allow a negative balance or a different currency", () => {
    const wallet = Wallet.create("player-2", "BRL");
    wallet.credit("credit", Money.from("5.00", "BRL"));
    expect(() => wallet.debit("too-much", Money.from("6.00", "BRL"))).toThrow();
    expect(() => wallet.credit("wrong-currency", Money.from("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe("5.00");
  });
});

describe("WagerTransaction", () => {
  const create = (kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK" = "BET", ref?: string) =>
    WagerTransaction.create({
      providerId: "provider",
      externalTransactionId: `ext-${Math.random()}`,
      idempotencyKey: `idem-${Math.random()}`,
      payloadHash: "a".repeat(64),
      walletId: "wallet-123",
      playerId: "player-123",
      roundId: "round-1",
      gameId: "game-1",
      kind,
      money: Money.from("10.00", "BRL"),
      referenceExternalTransactionId: ref,
    });

  it("enforces terminal states and terminal immutability", () => {
    const tx = create("BET");
    expect(tx.isTerminal()).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe("DEBIT");

    tx.markProcessed("ref-123", new Date(), Money.from("90.00", "BRL"));
    expect(tx.isTerminal()).toBe(true);
    expect(tx.status).toBe("PROCESSED");

    expect(() => tx.reject("INSUFFICIENT_FUNDS")).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail("PERMANENT_PROCESSING_ERROR")).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it("handles markPendingReference, reject and fail correctly", () => {
    const tx1 = create("REFUND", "ext-bet");
    tx1.markPendingReference();
    expect(tx1.status).toBe("PENDING_REFERENCE");
    expect(tx1.isTerminal()).toBe(false);

    // Can transition from PENDING_REFERENCE to REJECTED
    tx1.reject("REFERENCE_NOT_FOUND", Money.from("100.00", "BRL"));
    expect(tx1.status).toBe("REJECTED");
    expect(tx1.isTerminal()).toBe(true);

    const tx2 = create("BET");
    tx2.fail("PERMANENT_PROCESSING_ERROR", Money.from("100.00", "BRL"));
    expect(tx2.status).toBe("FAILED");
    expect(tx2.isTerminal()).toBe(true);
  });

  it("requires references for reversals and forbids OPENING via create", () => {
    expect(() => WagerTransaction.create({
      providerId: "p", externalTransactionId: "e", idempotencyKey: "i",
      payloadHash: "h", walletId: "w", playerId: "pl", roundId: "r", gameId: "g",
      kind: "OPENING", money: Money.from("10.00", "BRL"),
    })).toThrow(InvalidWagerError);

    expect(() => WagerTransaction.create({
      providerId: "p", externalTransactionId: "e", idempotencyKey: "i",
      payloadHash: "h", walletId: "w", playerId: "pl", roundId: "r", gameId: "g",
      kind: "REFUND", money: Money.from("10.00", "BRL"),
    })).toThrow(InvalidWagerError);

    expect(() => WagerTransaction.create({
      providerId: "p", externalTransactionId: "e", idempotencyKey: "i",
      payloadHash: "h", walletId: "w", playerId: "pl", roundId: "r", gameId: "g",
      kind: "ROLLBACK", money: Money.from("10.00", "BRL"),
    })).toThrow(InvalidWagerError);
  });

  it("calculates correct ledger directions including ROLLBACK", () => {
    const bet = create("BET");
    const win = create("WIN");
    const loss = create("LOSS");
    const refund = create("REFUND", "ext-bet");
    const rollback = create("ROLLBACK", "ext-target");

    expect(bet.ledgerDirectionFor()).toBe("DEBIT");
    expect(win.ledgerDirectionFor()).toBe("CREDIT");
    expect(loss.ledgerDirectionFor()).toBeNull();
    expect(refund.ledgerDirectionFor()).toBe("CREDIT");

    // ROLLBACK inverting BET (debit) -> CREDIT
    expect(rollback.ledgerDirectionFor(bet)).toBe("CREDIT");
    // ROLLBACK inverting WIN (credit) -> DEBIT
    expect(rollback.ledgerDirectionFor(win)).toBe("DEBIT");
    // ROLLBACK inverting REFUND (credit) -> DEBIT
    expect(rollback.ledgerDirectionFor(refund)).toBe("DEBIT");

    // ROLLBACK without reference throws
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerError);
  });

  it("validates matchesPayload accurately", () => {
    const tx = create("BET");
    expect(tx.matchesPayload("a".repeat(64))).toBe(true);
    expect(tx.matchesPayload("b".repeat(64))).toBe(false);
  });
});

describe("WalletLedgerEntry", () => {
  it("validates the recorded balance step and freezes its fields", () => {
    const before = Money.from("5.00", "BRL");
    const entry = WalletLedgerEntry.create({
      walletId: "wallet",
      transactionId: "transaction",
      direction: "CREDIT",
      money: Money.from("2.00", "BRL"),
      balanceBefore: before,
      balanceAfter: Money.from("7.00", "BRL"),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe("7.00");

    expect(() => WalletLedgerEntry.create({
      walletId: "wallet",
      transactionId: "bad",
      direction: "CREDIT",
      money: Money.from("2.00", "BRL"),
      balanceBefore: before,
      balanceAfter: Money.from("8.00", "BRL"),
    })).toThrow();
  });
});

describe("InboxRecord and OutboxMessage", () => {
  it("creates and rehydrates the persistent inbox identity", () => {
    const first = InboxRecord.create("processor", "sqs-message");
    const restored = InboxRecord.rehydrate({
      id: first.id,
      consumerName: first.consumerName,
      messageId: first.messageId,
      receivedAt: first.receivedAt,
    });
    expect(restored.messageId).toBe("sqs-message");
    expect(restored.id).toBe(first.id);
    expect(first.isProcessed()).toBe(false);
    first.markProcessed();
    expect(first.isProcessed()).toBe(true);
  });

  it("tracks outbox retries and publication state", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const event = OutboxMessage.create("events", "WAGER_PROCESSED", "transaction", {}, createdAt);
    event.recordPublishFailure(createdAt);
    expect(event.attempts).toBe(1);
    expect(event.nextAttemptAt!.toISOString()).toBe("2026-01-01T00:00:02.000Z");
    event.markPublished(createdAt);
    expect(event.attempts).toBe(2);
    expect(event.publishedAt?.toISOString()).toBe(createdAt.toISOString());
    expect(event.isPending()).toBe(false);
  });
});

describe("Integration Events", () => {
  it("creates valid envelopes with typed events", () => {
    const wallet = Wallet.create("p-1", "BRL", Money.from("100.00", "BRL"));
    const change = wallet.debit("tx-1", Money.from("25.00", "BRL"));
    const event = WalletBalanceChanged.from(wallet, change.entry, { correlationId: "corr-1" });

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
    const json = event.toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.data.walletId).toBe(wallet.id);
    expect(json.data.direction).toBe("DEBIT");
    expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(json.data.balanceBefore).toEqual({ amount: "100.00", currency: "BRL" });
    expect(json.data.balanceAfter).toEqual({ amount: "75.00", currency: "BRL" });

    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.eventType).toBe("WalletBalanceChanged");
    expect(outbox.aggregateId).toBe(wallet.id);
  });
});
