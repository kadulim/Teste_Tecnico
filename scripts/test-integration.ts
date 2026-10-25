process.env.INTEGRATION = "1";
const result = Bun.spawnSync(
  [process.execPath, "test", "test/processor.integration.test.ts"],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.exitCode = result.exitCode ?? 1;
