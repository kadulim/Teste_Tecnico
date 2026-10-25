import { dataSource } from "./infrastructure/database/data-source";

async function main(): Promise<void> {
  await dataSource.initialize();
  try {
    if (process.argv[2] === "down") await dataSource.undoLastMigration();
    else await dataSource.runMigrations({ transaction: "all" });
  } finally {
    await dataSource.destroy();
  }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", event: "migration_failed", error: String(error) }));
  process.exitCode = 1;
});
