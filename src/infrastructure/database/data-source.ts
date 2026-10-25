import "reflect-metadata";
import { DataSource } from "typeorm";
import { InitialSchema1720000000000 } from "./migrations/1720000000000-InitialSchema";

export const databaseOptions = {
  type: "postgres" as const,
  url: process.env.DATABASE_URL ?? "postgres://jungle:jungle@localhost:5432/jungle",
  migrations: [InitialSchema1720000000000],
  synchronize: false,
  logging: false,
  migrationsTableName: "typeorm_migrations",
};
export const dataSource = new DataSource(databaseOptions);
