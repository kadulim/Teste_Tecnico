/** Stable, machine-readable failure codes. See ARCHITECTURE.md for the taxonomy and retry guidance. */
export const FAILURE_CODES = [
  // business rejections (REJECTED): the provider should correct or give up, not blindly resend
  "INSUFFICIENT_FUNDS",
  "INSUFFICIENT_FUNDS_FOR_ROLLBACK",
  "CURRENCY_MISMATCH",
  "PLAYER_MISMATCH",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_NOT_PROCESSED",
  "REFERENCE_MISMATCH",
  "INVALID_REFUND_REFERENCE",
  "INVALID_ROLLBACK_REFERENCE",
  "REFERENCE_AMOUNT_MISMATCH",
  "REFERENCE_ALREADY_REVERSED",
  "WALLET_BALANCE_LIMIT_EXCEEDED",
  // permanent infrastructure failures (FAILED): auditable, set by the dead-letter drain
  "QUEUE_RETRY_EXHAUSTED",
  "PERMANENT_PROCESSING_ERROR",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
