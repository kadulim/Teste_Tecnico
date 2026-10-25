import {
  CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand,
  SendMessageCommand, DeleteMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";
import { WagerService } from "../../application/wager.service";
import { MetricsService } from "../../observability/metrics.service";
import { OutboxMessage } from "../../domain/outbox-message";

interface OutboxRow {
  id: string; queue_name: "requests" | "events"; event_type: string; aggregate_id: string;
  payload: unknown; attempts: number; created_at: Date; next_attempt_at: Date; published_at: Date | null;
}
interface Envelope { messageId: string; eventType: string; payload: { transactionId?: string } }

@Injectable()
export class SqsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
  private readonly requestName = process.env.REQUEST_QUEUE_NAME ?? "wager-requests";
  private readonly eventName = process.env.EVENT_QUEUE_NAME ?? "wager-events";
  private readonly maxReceives = Math.max(1, Number.parseInt(process.env.MAX_QUEUE_RECEIVES ?? "5", 10));
  private requestUrl = "";
  private requestDlqUrl = "";
  private eventUrl = "";
  private ready = false;
  private receiving = false;
  private receivingDlq = false;
  private publishing = false;
  private retrying = false;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly db: DataSource,
    private readonly wagers: WagerService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.requestUrl = await this.ensureQueue(this.requestName);
    this.eventUrl = await this.ensureQueue(this.eventName);
    this.ready = true;
  }

  onApplicationBootstrap(): void {
    this.timers.push(setInterval(() => void this.safePoll(), 500));
    this.timers.push(setInterval(() => void this.safePollDlq(), 1_000));
    this.timers.push(setInterval(() => void this.safePublish(), 500));
    this.timers.push(setInterval(() => void this.safeRetryReferences(), 2_000));
    this.log("info", "sqs_worker_started", { requestQueue: this.requestName, eventQueue: this.eventName });
  }

  async onModuleDestroy(): Promise<void> {
    this.ready = false;
    for (const timer of this.timers) clearInterval(timer);
    await this.client.destroy();
  }

  isReady(): boolean { return this.ready; }

  private async ensureQueue(name: string): Promise<string> {
    const dlqName = `${name}-dlq`;
    const dlq = await this.client.send(new CreateQueueCommand({
      QueueName: dlqName, Attributes: { MessageRetentionPeriod: "1209600" },
    }));
    const dlqUrl = dlq.QueueUrl;
    if (!dlqUrl) throw new Error(`Local SQS returned no URL for ${dlqName}`);
    if (name === this.requestName) this.requestDlqUrl = dlqUrl;
    const attrs = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: dlqUrl, AttributeNames: ["QueueArn"],
    }));
    const arn = attrs.Attributes?.QueueArn;
    if (!arn) throw new Error(`Local SQS returned no ARN for ${dlqName}`);
    const queue = await this.client.send(new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        VisibilityTimeout: "30",
        MessageRetentionPeriod: "1209600",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: this.maxReceives }),
      },
    }));
    if (!queue.QueueUrl) throw new Error(`Local SQS returned no URL for ${name}`);
    return queue.QueueUrl;
  }

  private async safePoll(): Promise<void> {
    if (!this.ready || this.receiving) return;
    this.receiving = true;
    try {
      const result = await this.client.send(new ReceiveMessageCommand({
        QueueUrl: this.requestUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30,
      }));
      for (const message of result.Messages ?? []) {
        if (!message.ReceiptHandle || !message.Body) continue;
        try {
          const envelope = JSON.parse(message.Body) as Envelope;
          if (!envelope.messageId || envelope.eventType !== "WAGER_REQUESTED" || !envelope.payload?.transactionId) {
            throw new Error("invalid wager request envelope");
          }
          // processSqsMessage returns only after inbox + financial state + outbox commit.
          await this.wagers.processSqsMessage(envelope.messageId, envelope.payload.transactionId);
          await this.client.send(new DeleteMessageCommand({ QueueUrl: this.requestUrl, ReceiptHandle: message.ReceiptHandle }));
        } catch (error) {
          this.log("error", "sqs_message_failed_will_retry", { error: String(error), messageId: message.MessageId });
          // Keep the message unacknowledged; SQS redrive policy bounds permanent failures.
        }
      }
    } catch (error) {
      this.log("error", "sqs_receive_failed", { error: String(error) });
    } finally {
      this.receiving = false;
    }
  }

  private async safePollDlq(): Promise<void> {
    if (!this.ready || this.receivingDlq || !this.requestDlqUrl) return;
    this.receivingDlq = true;
    try {
      const result = await this.client.send(new ReceiveMessageCommand({
        QueueUrl: this.requestDlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30,
      }));
      for (const message of result.Messages ?? []) {
        if (!message.ReceiptHandle || !message.Body) continue;
        try {
          const envelope = JSON.parse(message.Body) as Envelope;
          if (!envelope.messageId || envelope.eventType !== "WAGER_REQUESTED" || !envelope.payload?.transactionId) {
            this.log("error", "malformed_dead_letter_retained", { messageId: message.MessageId });
            continue;
          }
          // Exhausted redrives become an auditable FAILED state before the DLQ message is acknowledged.
          await this.wagers.failRedrivenMessage(envelope.messageId, envelope.payload.transactionId);
          await this.client.send(new DeleteMessageCommand({ QueueUrl: this.requestDlqUrl, ReceiptHandle: message.ReceiptHandle }));
        } catch (error) {
          this.log("error", "dead_letter_processing_failed", { messageId: message.MessageId, error: String(error) });
        }
      }
    } catch (error) {
      this.log("error", "dead_letter_receive_failed", { error: String(error) });
    } finally {
      this.receivingDlq = false;
    }
  }

  private async safePublish(): Promise<void> {
    if (!this.ready || this.publishing) return;
    this.publishing = true;
    try {
      await this.db.transaction(async (em) => {
        const rows = await em.query(
          `SELECT id,queue_name,event_type,aggregate_id,payload,attempts,created_at,next_attempt_at,published_at FROM message_outbox
           WHERE published_at IS NULL AND next_attempt_at <= now()
           ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 25`,
        ) as OutboxRow[];
        for (const row of rows) {
          const message = OutboxMessage.rehydrate({
            id: row.id, queueName: row.queue_name, eventType: row.event_type, aggregateId: row.aggregate_id,
            payload: row.payload, attempts: row.attempts, createdAt: new Date(row.created_at),
            nextAttemptAt: new Date(row.next_attempt_at), publishedAt: row.published_at ? new Date(row.published_at) : null,
          });
          try {
            const queueUrl = message.queueName === "requests" ? this.requestUrl : this.eventUrl;
            const body = JSON.stringify({ messageId: message.id, eventType: message.eventType, payload: message.payload });
            await this.client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
            message.markPublished();
            await em.query("UPDATE message_outbox SET published_at=$2,attempts=$3 WHERE id=$1", [message.id, message.publishedAt, message.attempts]);
            this.metrics.outboxPublishes.inc({ result: "published" });
          } catch (error) {
            message.recordPublishFailure();
            await em.query(
              "UPDATE message_outbox SET attempts=$2,next_attempt_at=$3 WHERE id=$1",
              [message.id, message.attempts, message.nextAttemptAt],
            );
            this.metrics.outboxPublishes.inc({ result: "retry" });
            this.log("error", "outbox_publish_failed", { outboxId: row.id, attempts: message.attempts, error: String(error) });
          }
        }
      });
    } catch (error) {
      this.log("error", "outbox_poll_failed", { error: String(error) });
    } finally {
      this.publishing = false;
    }
  }

  private async safeRetryReferences(): Promise<void> {
    if (!this.ready || this.retrying) return;
    this.retrying = true;
    try { await this.wagers.retryDueReferences(); }
    catch (error) { this.log("error", "reference_retry_poll_failed", { error: String(error) }); }
    finally { this.retrying = false; }
  }

  private log(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
    console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
  }
}
