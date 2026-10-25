import { randomUUID } from "node:crypto";
import { Money } from "./money";

export type LedgerDirection = "DEBIT" | "CREDIT";
export interface LedgerEntryProps {
  id?: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

/**
 * Append-only value object: every field is readonly and the instance is frozen.
 * There are deliberately no transition methods. The database also rejects UPDATE/DELETE (trigger).
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(p: LedgerEntryProps) {
    this.id = p.id ?? randomUUID();
    this.walletId = p.walletId;
    this.transactionId = p.transactionId;
    this.direction = p.direction;
    this.money = p.money;
    this.balanceBefore = p.balanceBefore;
    this.balanceAfter = p.balanceAfter;
    this.createdAt = p.createdAt ?? new Date();
    Object.freeze(this);
  }

  /** Validates `balanceBefore ± money === balanceAfter`. */
  static create(p: LedgerEntryProps): WalletLedgerEntry {
    if (!p.money.isPositive()) throw new Error("ledger amount must be positive");
    if (p.direction !== "CREDIT" && p.direction !== "DEBIT") throw new Error("invalid ledger direction");
    if (p.money.currency !== p.balanceBefore.currency || p.money.currency !== p.balanceAfter.currency) {
      throw new Error("ledger currency mismatch");
    }
    if (!WalletLedgerEntry.balanced(p)) throw new Error("ledger balances do not match direction and amount");
    return new WalletLedgerEntry(p);
  }

  /** Rebuilds already persisted state without re-running business validation. */
  static rehydrate(p: LedgerEntryProps): WalletLedgerEntry { return new WalletLedgerEntry(p); }

  isBalanced(): boolean { return WalletLedgerEntry.balanced(this); }

  private static balanced(p: LedgerEntryProps): boolean {
    const expected = p.direction === "CREDIT" ? p.balanceBefore.add(p.money) : p.balanceBefore.subtract(p.money);
    return expected.equals(p.balanceAfter);
  }
}
