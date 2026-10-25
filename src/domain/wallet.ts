import { randomUUID } from "node:crypto";
import { CurrencyMismatchError, InsufficientFundsError } from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { Money } from "./money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number | string;
  createdAt: Date;
  updatedAt: Date;
}
export interface BalanceChange {
  before: Money;
  after: Money;
  entry: WalletLedgerEntry;
}

/**
 * Aggregate root. `version` starts at 1 and increases only when the balance changes, so
 * version === 1 + (number of non-opening ledger entries). Concurrency control lives in the
 * persistence layer (SELECT ... FOR UPDATE on this wallet's row); this class keeps balance and
 * ledger entry consistent with each other.
 */
export class Wallet {
  private _version: number;

  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    version: number | string,
    readonly createdAt: Date,
    private _updatedAt: Date,
    private pendingOpening: Money | null,
  ) {
    if (_balance.currency !== currency) throw new CurrencyMismatchError();
    if (_balance.isNegative()) throw new Error("wallet balance cannot be negative");
    const v = typeof version === "number" ? version : Number.parseInt(String(version), 10);
    if (!Number.isInteger(v) || v < 1) throw new Error("invalid wallet version");
    this._version = v;
  }

  /** A new wallet. A positive initial balance must be backed by an OPENING ledger entry (see openingEntry). */
  static open(props: {
    id?: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (!props.playerId?.trim()) throw new Error("playerId is required");
    if (props.initialBalance.isNegative()) throw new Error("initial balance cannot be negative");
    const now = props.now ?? new Date();
    return new Wallet(
      props.id ?? randomUUID(),
      props.playerId.trim(),
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
      props.initialBalance.isPositive() ? props.initialBalance : null,
    );
  }

  /** Factory helper for creating empty or initialized wallet */
  static create(playerId: string, currency: string, initialBalance?: Money): Wallet {
    return Wallet.open({
      playerId,
      initialBalance: initialBalance ?? Money.zero(currency),
    });
  }

  /** Reconstructs persisted state; transitions are not re-validated. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(
      s.id,
      s.playerId,
      s.currency,
      s.balance,
      s.version,
      s.createdAt,
      s.updatedAt,
      null,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Credit ledger entry for the initial balance (balanceBefore = 0). Null when the wallet opens empty. */
  openingEntry(transactionId: string): WalletLedgerEntry | null {
    const opening = this.pendingOpening;
    if (!opening) return null;
    this.pendingOpening = null;
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction: "CREDIT",
      money: opening,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: opening,
      createdAt: this.createdAt,
    });
  }

  credit(transactionId: string, money: Money): BalanceChange {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new Error("credit amount must be positive");
    return this.apply(transactionId, money, "CREDIT");
  }

  debit(transactionId: string, money: Money): BalanceChange {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new Error("debit amount must be positive");
    if (this._balance.isLessThan(money)) throw new InsufficientFundsError();
    return this.apply(transactionId, money, "DEBIT");
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError();
  }

  private apply(transactionId: string, money: Money, direction: LedgerDirection): BalanceChange {
    const before = this._balance;
    const after = direction === "CREDIT" ? before.add(money) : before.subtract(money);
    const at = new Date();
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return { before, after, entry };
  }
}
