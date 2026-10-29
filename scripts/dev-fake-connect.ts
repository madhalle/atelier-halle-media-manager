// DEVELOPMENT/TEST ONLY: marks an account as connected to a simulated identity
// so the scheduler can be exercised against the fake platform. Refuses to run
// against production data. Real connections come from platform sign-in.
//
// Usage: node scripts/dev-fake-connect.ts --env development --account <id>
import { parseArgs } from "node:util";
import { loadConfig } from "../src/server/config.ts";
import { createAccountsRepo } from "../src/storage/accounts-repo.ts";
import { dataPaths } from "../src/storage/data-dir.ts";
import { openDatabase } from "../src/storage/db.ts";

const { values } = parseArgs({ options: { env: { type: "string" }, account: { type: "string" } } });
if (values.env !== "development" && values.env !== "test") {
  process.stderr.write("Refusing: --env must be development or test.\n");
  process.exit(1);
}
if (!values.account) {
  process.stderr.write("Missing --account <id>.\n");
  process.exit(1);
}
const config = loadConfig({ ...process.env, MEDIA_MANAGER_ENV: values.env });
const db = openDatabase(dataPaths(config.dataDir).database);
try {
  const accounts = createAccountsRepo(db);
  const account = accounts.get(values.account);
  const updated = accounts.markConnected(
    account.id,
    {
      providerAccountId: `fake-${account.id.slice(0, 8)}`,
      username: `simulated_${account.platform}`,
      displayName: "Simulated account",
      avatarUrl: null,
      accountType: "SIMULATED",
      verifiedAt: new Date().toISOString(),
    },
    `fake:${account.id}`,
  );
  process.stdout.write(`${updated.displayName} is now connected to a SIMULATED ${updated.platform} identity.\n`);
} finally {
  db.close();
}
