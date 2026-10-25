import {
  Body, Controller, DefaultValuePipe, Get, Headers, HttpCode, HttpStatus, Param, ParseIntPipe, Post,
  Query, Res, UnprocessableEntityException, ParseUUIDPipe, ServiceUnavailableException,
} from "@nestjs/common";
import { Response } from "express";
import { WagerService } from "../application/wager.service";
import { SqsService } from "../infrastructure/sqs/sqs.service";
import { MetricsService } from "../observability/metrics.service";
import { DataSource } from "typeorm";
import { CreateWalletDto } from "./dto/create-wallet.dto";
import { SubmitWagerDto } from "./dto/submit-wager.dto";

@Controller("wallets")
export class WalletController {
  constructor(private readonly wagers: WagerService) {}

  @Post()
  create(@Body() body: CreateWalletDto): Promise<Record<string, unknown>> {
    return this.wagers.createWallet(body);
  }

  @Get(":walletId")
  get(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<Record<string, unknown>> {
    return this.wagers.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId", ParseUUIDPipe) walletId: string,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query("cursor") cursor?: string,
  ): Promise<Record<string, unknown>> {
    if (limit < 1 || limit > 200 || offset < 0) {
      throw new UnprocessableEntityException("limit must be 1..200 and offset must be non-negative");
    }
    return this.wagers.getLedger(walletId, limit, offset, cursor);
  }

  @Post(":walletId/reconciliation")
  reconcilePost(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<Record<string, unknown>> {
    return this.wagers.reconcile(walletId);
  }

  @Get(":walletId/reconciliation")
  reconcileGet(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<Record<string, unknown>> {
    return this.wagers.reconcile(walletId);
  }
}

@Controller()
export class TransactionController {
  constructor(private readonly wagers: WagerService) {}

  @Post(["wagering/transactions", "transactions"])
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey) throw new UnprocessableEntityException("Idempotency-Key header is required");
    const result = await this.wagers.submit(body, idempotencyKey);
    const status = result.status;
    response.status(
      status === "REJECTED" ? 422 :
      status === "FAILED" ? 503 :
      status === "PROCESSED" ? 200 :
      202,
    );
    return result;
  }

  @Get(["wagering/transactions/:transactionId", "transactions/:transactionId"])
  get(@Param("transactionId", ParseUUIDPipe) transactionId: string): Promise<Record<string, unknown>> {
    return this.wagers.getTransaction(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    return this.wagers.getTransactionByExternal(providerId, externalTransactionId);
  }
}

@Controller("health")
export class HealthController {
  constructor(private readonly db: DataSource, private readonly queues: SqsService) {}

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<Record<string, string>> {
    await this.db.query("SELECT 1");
    if (!this.queues.isReady()) throw new ServiceUnavailableException("SQS queues are not ready");
    return { status: "ready" };
  }
}

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get("metrics")
  async get(@Res() response: Response): Promise<void> {
    response.type("text/plain; version=0.0.4").send(await this.metrics.render());
  }
}
