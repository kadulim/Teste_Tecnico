export interface InboxMessageState {
  id?: string;
  consumerName: string;
  messageId: string;
  payloadHash?: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

/** Persistent dedup record, unique by (consumerName, messageId) in PostgreSQL. */
export class InboxMessage {
  readonly id: string;
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  private _processedAt: Date | null;

  private constructor(
    consumerName: string,
    messageId: string,
    payloadHash: string,
    receivedAt: Date,
    processedAt: Date | null,
    id?: string,
  ) {
    this.consumerName = consumerName;
    this.messageId = messageId;
    this.payloadHash = payloadHash;
    this.receivedAt = receivedAt;
    this._processedAt = processedAt;
    this.id = id ?? `${consumerName}:${messageId}`;
  }

  static create(
    input:
      | string
      | { consumerName: string; messageId: string; payloadHash?: string; receivedAt?: Date },
    messageId?: string,
    payloadHash?: string,
  ): InboxMessage {
    if (typeof input === "string") {
      const consumerName = input.trim();
      const msgId = (messageId ?? "").trim();
      if (!consumerName || !msgId) throw new Error("inbox identity fields are required");
      return new InboxMessage(consumerName, msgId, payloadHash ?? "", new Date(), null);
    }
    const consumer = input.consumerName?.trim();
    const msgId = input.messageId?.trim();
    if (!consumer || !msgId) throw new Error("inbox identity fields are required");
    return new InboxMessage(
      consumer,
      msgId,
      input.payloadHash ?? "",
      input.receivedAt ?? new Date(),
      null,
    );
  }

  /** Alias used by the challenge skeleton. */
  static receive(p: {
    consumerName: string;
    messageId: string;
    payloadHash?: string;
    receivedAt?: Date;
  }): InboxMessage {
    return InboxMessage.create(p);
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(
      s.consumerName,
      s.messageId,
      s.payloadHash ?? "",
      s.receivedAt,
      s.processedAt ?? null,
      s.id,
    );
  }

  get processedAt(): Date | null {
    return this._processedAt;
  }
  isProcessed(): boolean {
    return this._processedAt !== null;
  }
  markProcessed(at: Date = new Date()): void {
    if (this._processedAt) throw new Error("inbox message already processed");
    this._processedAt = at;
  }
}

/** Backward compatibility alias */
export { InboxMessage as InboxRecord };
