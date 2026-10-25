import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DataSource } from "typeorm";
import { AppModule } from "./app.module";
import { NoopAuthGuard } from "./http/auth/noop-auth.guard";
import { JsonLogger } from "./observability/json-logger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalGuards(app.get(NoopAuthGuard));
  await app.get(DataSource).runMigrations({ transaction: "all" });
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  await app.listen(port, "0.0.0.0");
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event: "http_listening", port }));
}
bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "startup_failed", error: String(error) }));
  process.exit(1);
});
