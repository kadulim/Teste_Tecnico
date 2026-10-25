import { Injectable } from "@nestjs/common";
import { Counter, Registry, collectDefaultMetrics } from "prom-client";

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly submissions: Counter<"">;
  readonly messagesProcessed: Counter<"">;
  readonly results: Counter<"status">;
  readonly outboxPublishes: Counter<"result">;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.submissions = new Counter({ name: "wager_submissions_total", help: "Accepted HTTP wager submissions", registers: [this.registry] });
    this.messagesProcessed = new Counter({ name: "wager_messages_processed_total", help: "SQS messages committed by the inbox processor", registers: [this.registry] });
    this.results = new Counter({ name: "wager_results_total", help: "Terminal wager processing results", labelNames: ["status"], registers: [this.registry] });
    this.outboxPublishes = new Counter({ name: "outbox_publish_attempts_total", help: "Outbox publish outcomes", labelNames: ["result"], registers: [this.registry] });
  }

  async render(): Promise<string> { return this.registry.metrics(); }
}
