// Opens the running app in the default browser via the owner-only launch
// file, so the launch token never appears in process arguments.
// Usage: npm run open [-- --env development]
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/server/config.ts";
import { dataPaths } from "../src/storage/data-dir.ts";

const { values } = parseArgs({ options: { env: { type: "string", default: "production" } } });
const config = loadConfig({ ...process.env, MEDIA_MANAGER_ENV: values.env });
const { launchFile } = dataPaths(config.dataDir);

if (!existsSync(launchFile)) {
  process.stderr.write(`Media Manager does not appear to be running (no launch file in ${config.dataDir}).\n`);
  process.exit(1);
}
execFile("/usr/bin/open", [launchFile], (err) => {
  if (err) {
    process.stderr.write(`Could not open the browser: ${err.message}\n`);
    process.exit(1);
  }
});
