// Process entry point: `node src/server/main.ts`.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakePlatform } from "../platforms/fake.ts";
import { createPlatformServices } from "../platforms/services.ts";
import type { AdapterRegistry } from "../platforms/types.ts";
import { startScheduler } from "../scheduler/scheduler.ts";
import { createAccountsRepo } from "../storage/accounts-repo.ts";
import { createKeychainStore, createMemoryStore, type CredentialStore } from "../storage/credentials.ts";
import { acquireInstanceLock } from "../storage/instance-lock.ts";
import { createMediaStore } from "../storage/media-store.ts";
import { createPostsRepo } from "../storage/posts-repo.ts";
import { createScheduleRepo } from "../storage/schedule-repo.ts";
import { dataPaths, prepareDataDir } from "../storage/data-dir.ts";
import { openDatabase } from "../storage/db.ts";
import { createBackup, latestBackup } from "../storage/backup.ts";
import { migrate, pendingMigrations } from "../storage/migrate.ts";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { rotateServiceLog, SERVICE_LOG } from "./launch-agent.ts";
import { launchUrl, removeLaunchFile, writeLaunchFile } from "./launch.ts";
import { createSessionStore } from "./sessions.ts";

const LAUNCH_ROTATE_MS = 5 * 60_000;
const DAILY_BACKUP_MS = 24 * 60 * 60_000;

async function main(): Promise<void> {
  // Everything this process creates (database, WAL, media, logs) is owner-only.
  process.umask(0o077);
  const config = loadConfig();
  const paths = prepareDataDir(config.dataDir);
  const releaseLock = acquireInstanceLock(join(paths.root, "server.lock"));

  const db = openDatabase(paths.database);
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
  // Upgrading an existing database is the riskiest moment; keep a copy from just before it.
  if (pendingMigrations(db) > 0) await createBackup(db, paths, { reason: "pre-migration", appVersion: pkg.version });
  migrate(db);

  const sessions = createSessionStore();
  const publishLaunchLink = () => writeLaunchFile(paths.launchFile, launchUrl(config.port, sessions.mintLaunchToken()));

  // Tests never touch the user's Keychain; development uses its own Keychain service name.
  const credentials: CredentialStore =
    config.env === "test"
      ? createMemoryStore()
      : createKeychainStore(config.env === "production" ? "com.atelierhalle.media-manager" : "com.atelierhalle.media-manager.dev");
  let keychain = { ok: true, reason: null as string | null, kind: credentials.kind };
  const checkKeychain = async () => {
    const r = await credentials.probe();
    keychain = { ok: r.ok, reason: r.ok ? null : r.reason, kind: credentials.kind };
  };
  await checkKeychain();

  const now = () => new Date();
  const accounts = createAccountsRepo(db);
  const posts = createPostsRepo(db, accounts);
  const te = config.testEndpoints;
  const services = createPlatformServices({
    db,
    accounts,
    credentials,
    port: config.port,
    now,
    ...(te ? { endpoints: { ...te, r2: () => te.r2 }, allowInsecureLoopback: true } : {}),
  });

  const app = await buildApp({
    config,
    db,
    sessions,
    version: pkg.version,
    onLaunchTokenUsed: publishLaunchLink,
    credentials,
    services,
    keychainStatus: () => keychain,
  });
  if (keychain.ok) app.log.info({ keychain: credentials.kind }, "keychain check passed");
  else app.log.warn("macOS Keychain unavailable; connected accounts can't publish until it's accessible");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    clearInterval(rotation);
    await scheduler.stop();
    await app.close();
    db.close();
    removeLaunchFile(paths.launchFile);
    releaseLock();
    process.exit(0);
  };

  await app.listen({ host: config.host, port: config.port });

  // The backend owns scheduling; it keeps running with no browser open.
  const fakes = { instagram: createFakePlatform("instagram"), pinterest: createFakePlatform("pinterest") };
  const adapters: AdapterRegistry = config.fakePlatforms ? (p) => fakes[p] : services.registry(config.livePublishing);
  let lastRenewal = 0;
  let lastBackupCheck = 0;
  const dailyBackup = async () => {
    const latest = await latestBackup(paths, "daily");
    if (latest && Date.now() - Date.parse(latest.createdAt) < DAILY_BACKUP_MS) return;
    const m = await createBackup(db, paths, { reason: "daily", appVersion: pkg.version });
    app.log.info({ backup: m.id, files: m.mediaFiles.length }, "daily backup created");
  };
  const scheduler = startScheduler({
    accounts,
    posts,
    media: createMediaStore(db, dataPaths(config.dataDir).media),
    schedule: createScheduleRepo(db, posts),
    adapters,
    now: () => new Date(),
    log: app.log,
    intervalMs: config.schedulerIntervalMs,
    // Hourly: re-check the Keychain and renew platform tokens before they expire.
    onTick: async () => {
      if (Date.now() - lastBackupCheck >= 60 * 60_000) {
        lastBackupCheck = Date.now();
        await dailyBackup().catch((err: unknown) => app.log.error({ err }, "daily backup failed"));
        await rotateServiceLog(join(paths.logs, SERVICE_LOG)).catch((err: unknown) => app.log.error({ err }, "log rotation failed"));
      }
      if (Date.now() - lastRenewal < 60 * 60_000) return;
      lastRenewal = Date.now();
      await checkKeychain();
      if (!keychain.ok || config.fakePlatforms) return;
      for (const id of await services.tokens.renewDue(accounts.list())) {
        const a = accounts.get(id);
        createScheduleRepo(db, posts).markAccountNeedsReconnect(a, now());
        app.log.warn({ accountId: id }, "platform connection expired; reconnect needed");
      }
    },
  });
  if (config.fakePlatforms) app.log.warn("SIMULATED platforms are enabled: nothing is sent to Instagram or Pinterest");
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
