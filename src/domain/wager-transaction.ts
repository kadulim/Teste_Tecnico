import { randomUUID } from "node:crypto";
import { InvalidTransactionStateError, InvalidWagerError } from "./errors";
import { FailureCode } from "./failure-codes";
import { LedgerDirection } from "./ledger-entry";
import { Money } from "./money";

export type WagerKind = "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
export type ExternalWagerKind = Exclude<WagerKind, "OPENING">;
export type WagerStatus = "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";

export interface WagerTransactionState {
  id: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string | null;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  /** Id of the referenced operation at the provider (not the internal id). */
  referenceExternalTransactionId: string | null;
  createdAt: Date;
  status: WagerStatus;
  /** Internal id of the referenced transaction, once resolved. */
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  processedAt: Date | null;
  /** Wallet balance observed when the transaction reached a terminal state (returned on replay). */
  resultBalance: Money | null;
}

export type CreateWagerTransactionProps = {
  id?: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string | null;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind?: WagerKind;
  type?: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string | null;
  createdAt?: Date;
};

/**
 * Valid transitions:
 *   PENDING           -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PROCESSED | REJECTED | FAILED are terminal: any further transition is a programming error
 *   (InvalidTransactionStateError). The database mirrors this with a trigger.
 */
export class WagerTransaction {
  private constructor(private s: WagerTransactionState) {}

  /** Born in PENDING. Validates the reference requirement per kind. */
  static create(p: CreateWagerTransactionProps): WagerTransaction {
    const kind = p.kind ?? p.type;
    if (!kind) throw new InvalidWagerError("transaction kind is required");
    if (kind === "OPENING") throw new InvalidWagerError("OPENING is internal and cannot be submitted");
    if (!["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"].includes(kind)) throw new InvalidWagerError("unknown transaction kind");
    if (!p.money.isPositive()) throw new InvalidWagerError("amount must be greater than zero");
    const requiresReference = kind === "REFUND" || kind === "ROLLBACK";
    if (requiresReference && !p.referenceExternalTransactionId?.trim()) {
      throw new InvalidWagerError("referenceExternalTransactionId is required for reversals");
    }
    return new WagerTransaction({
      id: p.id ?? randomUUID(),
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: p.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
      kind,
      money: p.money,
      referenceExternalTransactionId: p.referenceExternalTransactionId ?? null,
      createdAt: p.createdAt ?? new Date(),
      status: "PENDING",
      referenceTransactionId: null,
      failureCode: null,
      processedAt: null,
      resultBalance: null,
    });
  }

  /** Internal opening credit: born already PROCESSED, never accepted from the API or the queue. */
  static opening(p: {
    id?: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at?: Date;
  }): WagerTransaction {
    const at = p.at ?? new Date();
    return new WagerTransaction({
      id: p.id ?? randomUUID(),
      providerId: null,
      externalTransactionId: null,
      idempotencyKey: null,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: "__opening__",
      gameId: "__internal__",
      kind: "OPENING",
      money: p.money,
      referenceExternalTransactionId: null,
      createdAt: at,
      status: "PROCESSED",
      referenceTransactionId: null,
      failureCode: null,
      processedAt: at,
      resultBalance: p.money,
    });
  }

  /** Rebuilds persisted state; does not re-run transition validation. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id(): string { return this.s.id; }
  get providerId(): string | null { return this.s.providerId; }
  get externalTransactionId(): string | null { return this.s.externalTransactionId; }
  get idempotencyKey(): string | null { return this.s.idempotencyKey; }
  get payloadHash(): string { return this.s.payloadHash; }
  get walletId(): string { return this.s.walletId; }
  get playerId(): string { return this.s.playerId; }
  get roundId(): string { return this.s.roundId; }
  get gameId(): string { return this.s.gameId; }
  get kind(): WagerKind { return this.s.kind; }
  get type(): WagerKind { return this.s.kind; }
  get money(): Money { return this.s.money; }
  get referenceExternalTransactionId(): string | null { return this.s.referenceExternalTransactionId; }
  get createdAt(): Date { return this.s.createdAt; }
  get status(): WagerStatus { return this.s.status; }
  get referenceTransactionId(): string | null { return this.s.referenceTransactionId; }
  get failureCode(): FailureCode | null { return this.s.failureCode; }
  get processedAt(): Date | null { return this.s.processedAt; }
  get resultBalance(): Money | null { return this.s.resultBalance; }

  markProcessed(
    referenceTransactionId: string | null = null,
    at: Date = new Date(),
    resultBalance: Money = this.s.money,
  ): void {
    this.assertOpen("PROCESSED");
    this.s = {
      ...this.s,
      status: "PROCESSED",
      referenceTransactionId,
      processedAt: at,
      resultBalance,
      failureCode: null,
    };
  }

  markPendingReference(): void {
    this.assertOpen("PENDING_REFERENCE");
    this.s = { ...this.s, status: "PENDING_REFERENCE" };
  }

  reject(code: FailureCode, observedBalance?: Money, at: Date = new Date()): void {
    this.assertOpen("REJECTED");
    this.s = {
      ...this.s,
      status: "REJECTED",
      failureCode: code,
      processedAt: at,
      resultBalance: observedBalance ?? null,
    };
  }

  fail(code: FailureCode, observedBalance?: Money | null, at: Date = new Date()): void {
    this.assertOpen("FAILED");
    this.s = {
      ...this.s,
      status: "FAILED",
      failureCode: code,
      processedAt: at,
      resultBalance: observedBalance ?? null,
    };
  }

  transition(status: WagerStatus, observedBalance?: Money): void {
    switch (status) {
      case "PROCESSED":
        this.markProcessed(null, new Date(), observedBalance ?? this.s.money);
        break;
      case "PENDING_REFERENCE":
        this.markPendingReference();
        break;
      case "REJECTED":
        this.reject((this.s.failureCode ?? "INSUFFICIENT_FUNDS") as FailureCode, observedBalance);
        break;
      case "FAILED":
        this.fail((this.s.failureCode ?? "PERMANENT_PROCESSING_ERROR") as FailureCode, observedBalance);
        break;
      default:
        this.assertOpen(status);
        this.s = { ...this.s, status };
    }
  }

  isTerminal(): boolean {
    return this.s.status === "PROCESSED" || this.s.status === "REJECTED" || this.s.status === "FAILED";
  }

  affectsBalance(): boolean {
    return this.s.kind !== "LOSS";
  }

  requiresReference(): boolean {
    return this.s.kind === "REFUND" || this.s.kind === "ROLLBACK";
  }

  matchesPayload(payloadHash: string): boolean {
    return this.s.payloadHash === payloadHash;
  }

  /** BET debits; WIN/REFUND/OPENING credit; ROLLBACK inverts its reference; LOSS has no ledger effect (null). */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    switch (this.s.kind) {
      case "LOSS":
        return null;
      case "BET":
        return "DEBIT";
      case "WIN":
      case "REFUND":
      case "OPENING":
        return "CREDIT";
      case "ROLLBACK":
        if (!reference) throw new InvalidWagerError("ROLLBACK needs its reference to define a direction");
        if (reference.kind === "BET") return "CREDIT";
        if (reference.kind === "WIN" || reference.kind === "REFUND") return "DEBIT";
        throw new InvalidWagerError(`ROLLBACK cannot reverse a ${reference.kind}`);
    }
  }

  private assertOpen(next: WagerStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`terminal transaction (${this.s.status}) cannot move to ${next}`);
    }
  }
}
