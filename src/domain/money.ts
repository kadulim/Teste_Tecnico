import { CurrencyMismatchError, MoneyFormatError, MoneyOverflowError } from "./errors";

export { MoneyFormatError, MoneyOverflowError };

export interface MoneyProps { amount: string; currency: string }

const INPUT_AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const SIGNED_AMOUNT = /^-?(0|[1-9]\d{0,17})\.\d{2}$/;

/** Exact, immutable money in minor units. Monetary values never pass through JS number. */
export class Money {
  private static readonly maxMinorUnits = 99999999999999999999n;
  private constructor(private readonly minorUnits: bigint, readonly currency: string) {
    if (minorUnits > Money.maxMinorUnits || minorUnits < -Money.maxMinorUnits) throw new MoneyOverflowError();
    Object.freeze(this);
  }

  /** Contract entry point: non-negative decimal string with exactly two fractional digits. */
  static from(input: MoneyProps | string, currency?: string): Money {
    const props: MoneyProps = typeof input === "string" ? { amount: input, currency: currency ?? "" } : input;
    Money.assertCurrency(props?.currency);
    if (typeof props.amount !== "string" || !INPUT_AMOUNT.test(props.amount)) {
      throw new MoneyFormatError("amount must be a non-negative decimal string with exactly two fractional digits");
    }
    return Money.parse(props.amount, props.currency);
  }

  /** Persistence/derived values (may be negative, e.g. a reconciliation difference). */
  static rehydrate(amount: string, currency: string): Money {
    Money.assertCurrency(currency);
    if (typeof amount !== "string" || !SIGNED_AMOUNT.test(amount)) {
      throw new MoneyFormatError("persisted amount is not a two-digit decimal string");
    }
    return Money.parse(amount, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  private static parse(amount: string, currency: string): Money {
    const negative = amount.startsWith("-");
    const [whole, fraction] = (negative ? amount.slice(1) : amount).split(".");
    const minor = BigInt(whole) * 100n + BigInt(fraction);
    return new Money(negative ? -minor : minor, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new MoneyFormatError("currency must be a three-letter uppercase ISO code");
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError();
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money { return new Money(-this.minorUnits, this.currency); }
  isZero(): boolean { return this.minorUnits === 0n; }
  isPositive(): boolean { return this.minorUnits > 0n; }
  isNegative(): boolean { return this.minorUnits < 0n; }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps { return { amount: this.amountString(), currency: this.currency }; }
  toString(): string { return `${this.currency} ${this.amountString()}`; }

  private amountString(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const digits = absolute.toString().padStart(3, "0");
    return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }
}
