// Process entry point: `node src/server/main.ts`.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireInstanceLock } from "../storage/instance-lock.ts";
import { prepareDataDir } from "../storage/data-dir.ts";
import { openDatabase } from "../storage/db.ts";
import { migrate } from "../storage/migrate.ts";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { launchUrl, removeLaunchFile, writeLaunchFile } from "./launch.ts";
import { createSessionStore } from "./sessions.ts";

const LAUNCH_ROTATE_MS = 5 * 60_000;

async function main(): Promise<void> {
  // Everything this process creates (database, WAL, media, logs) is owner-only.
  process.umask(0o077);
  const config = loadConfig();
  const paths = prepareDataDir(config.dataDir);
  const releaseLock = acquireInstanceLock(join(paths.root, "server.lock"));

  const db = openDatabase(paths.database);
  migrate(db);

  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
  const sessions = createSessionStore();
  const publishLaunchLink = () => writeLaunchFile(paths.launchFile, launchUrl(config.port, sessions.mintLaunchToken()));

  const app = await buildApp({ config, db, sessions, version: pkg.version, onLaunchTokenUsed: publishLaunchLink });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    clearInterval(rotation);
    await app.close();
    db.close();
    removeLaunchFile(paths.launchFile);
    releaseLock();
    process.exit(0);
  };

  await app.listen({ host: config.host, port: config.port });
  publishLaunchLink();
  const rotation = setInterval(publishLaunchLink, LAUNCH_ROTATE_MS);
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // The token is deliberately not printed: terminal scrollback and service logs are long-lived.
  process.stdout.write(
    `\nMedia Manager (${config.env}) is running at http://127.0.0.1:${config.port}\n` +
      `Data directory: ${config.dataDir}\n` +
      `Open it with:  npm run open${config.env === "production" ? "" : ` -- --env ${config.env}`}\n\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`Media Manager failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
