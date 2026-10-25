import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { databaseOptions } from "./infrastructure/database/data-source";
import { SqsService } from "./infrastructure/sqs/sqs.service";
import { WagerService } from "./application/wager.service";
import { HealthController, MetricsController, TransactionController, WalletController } from "./http/controllers";
import { NoopAuthGuard } from "./http/auth/noop-auth.guard";
import { MetricsService } from "./observability/metrics.service";

@Module({
  imports: [TypeOrmModule.forRoot({ ...databaseOptions, autoLoadEntities: false })],
  controllers: [WalletController, TransactionController, HealthController, MetricsController],
  providers: [WagerService, SqsService, MetricsService, NoopAuthGuard],
})
export class AppModule {}
