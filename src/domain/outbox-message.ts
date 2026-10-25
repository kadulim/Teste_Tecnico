import { randomUUID } from "node:crypto";
import { IntegrationEvent, IntegrationEventJson } from "./integration-events";

export interface OutboxMessageState {
  id: string;
  queueName?: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>> | unknown;
  occurredAt?: Date;
  createdAt?: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

/** Event waiting to be published after the financial transaction committed. Retry state is persisted. */
export class OutboxMessage {
  readonly id: string;
  readonly queueName: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date | null;
  private _publishedAt: Date | null;

  private constructor(
    id: string,
    queueName: string,
    aggregateId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt: Date | null,
    publishedAt: Date | null,
    createdAt?: Date,
  ) {
    this.id = id;
    this.queueName = queueName;
    this.aggregateId = aggregateId;
    this.eventType = eventType;
    this.payload = payload;
    this.occurredAt = occurredAt;
    this.createdAt = createdAt ?? occurredAt;
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt;
    this._publishedAt = publishedAt;
  }

  /** The event id is reused as the outbox id: a stable key for consumers to deduplicate on. */
  static enqueue(event: IntegrationEvent<object>, queueName: "requests" | "events" = "events"): OutboxMessage {
    const json: IntegrationEventJson<object> = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      queueName,
      event.aggregateId,
      event.eventType,
      json as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
      null,
      event.occurredAt,
    );
  }

  static create(
    queueName: string,
    eventType: string,
    aggregateId: string,
    payload: unknown,
    occurredAt: Date = new Date(),
  ): OutboxMessage {
    const id = randomUUID();
    return new OutboxMessage(
      id,
      queueName,
      aggregateId,
      eventType,
      (payload && typeof payload === "object" ? payload : { value: payload }) as Record<string, unknown>,
      occurredAt,
      0,
      occurredAt,
      null,
      occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.queueName ?? "events",
      s.aggregateId,
      s.eventType,
      (s.payload && typeof s.payload === "object" ? s.payload : { value: s.payload }) as Record<string, unknown>,
      s.occurredAt ?? s.createdAt ?? new Date(),
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
      s.createdAt ?? s.occurredAt ?? new Date(),
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | null {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === null;
  }
  isDue(now: Date = new Date()): boolean {
    return this.isPending() && (this._nextAttemptAt === null || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date = new Date()): void {
    if (!this.isPending()) throw new Error("outbox message already published");
    this._publishedAt = at;
    this._nextAttemptAt = null;
    this._attempts += 1;
  }

  /** Increments attempts and applies exponential backoff (2^attempts seconds, capped at 5 minutes). */
  scheduleRetry(now: Date = new Date()): void {
    this._attempts += 1;
    const delaySeconds = Math.min(300, 2 ** Math.min(this._attempts, 8));
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1_000);
  }

  recordPublishFailure(now: Date = new Date()): void {
    this.scheduleRetry(now);
  }
}
