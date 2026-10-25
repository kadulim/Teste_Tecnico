import { randomUUID } from "node:crypto";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { MoneyProps } from "./money";
import { Wallet } from "./wallet";
import { WagerTransaction } from "./wager-transaction";

export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}

export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
  data: T;
}

export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Envelope written to the outbox payload. `data` carries MoneyProps (decimal strings), never Money. */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): IntegrationEventJson<T> {
    return {
      eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId,
      correlationId: this.correlationId, ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data as T,
    };
  }
}

interface TransactionEventBase {
  transactionId: string;
  walletId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  kind: string;
}
const base = (tx: WagerTransaction): TransactionEventBase => ({
  transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId, kind: tx.kind,
});
const balanceOf = (tx: WagerTransaction): MoneyProps => (tx.resultBalance ?? { amount: "0.00", currency: tx.money.currency }) as MoneyProps;
const moneyOf = (m: { toJSON(): MoneyProps }): MoneyProps => m.toJSON();

export interface WagerTransactionProcessedData extends TransactionEventBase {
  money: MoneyProps; balance: MoneyProps; ledgerEntryCreated: boolean;
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  static from(tx: WagerTransaction, ledgerEntryCreated: boolean, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      aggregateId: tx.id, ...ctx,
      data: { ...base(tx), money: tx.money.toJSON(), balance: tx.resultBalance ? moneyOf(tx.resultBalance) : balanceOf(tx), ledgerEntryCreated },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionEventBase {
  failureCode: string; balance: MoneyProps;
}
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      aggregateId: tx.id, ...ctx,
      data: { ...base(tx), failureCode: tx.failureCode ?? "UNKNOWN", balance: tx.resultBalance ? moneyOf(tx.resultBalance) : balanceOf(tx) },
    });
  }
}

export interface WagerTransactionFailedData extends TransactionEventBase { failureCode: string }
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed({
      aggregateId: tx.id, ...ctx, data: { ...base(tx), failureCode: tx.failureCode ?? "UNKNOWN" },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventBase {
  referenceExternalTransactionId: string | null; attempts: number;
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  static from(tx: WagerTransaction, attempts: number, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      aggregateId: tx.id, ...ctx,
      data: { ...base(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId, attempts },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
/** Emitted only when a ledger entry exists, i.e. the balance actually moved. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      aggregateId: wallet.id, ...ctx,
      data: {
        walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
        money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
      },
    });
  }
}
