export class DomainError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = new.target.name; }
}
export class InsufficientFundsError extends DomainError {
  constructor() { super("wallet has insufficient funds", "INSUFFICIENT_FUNDS"); }
}
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) { super(message, "INVALID_TRANSACTION_STATE"); }
}
export class CurrencyMismatchError extends DomainError {
  constructor() { super("currency mismatch: operation currency differs", "CURRENCY_MISMATCH"); }
}
export class MoneyFormatError extends DomainError {
  constructor(message: string) { super(message, "INVALID_MONEY"); }
}
export class MoneyOverflowError extends DomainError {
  constructor() { super("money exceeds numeric(20,2) storage range", "MONEY_OVERFLOW"); }
}
export class InvalidWagerError extends DomainError {
  constructor(message: string) { super(message, "INVALID_WAGER"); }
}
