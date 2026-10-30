// Backups from the command line.
//
//   npm run backup                       back up now
//   npm run backup -- list               list backups, newest first
//   npm run backup -- verify <id>        check a backup is complete and intact
//   npm run backup -- export <id> <dir>  copy a backup to e.g. an external drive
//   npm run backup -- restore <id|dir>   restore (the app must be stopped)
//
// Add `--env development` to work on development data.
import { existsSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/server/config.ts";
import { backupOwnBytes, BackupError, createBackup, exportBackup, listBackups, restoreBackup, verifyBackup, verifyBackupById } from "../src/storage/backup.ts";
import { dataPaths, prepareDataDir } from "../src/storage/data-dir.ts";
import { openDatabase } from "../src/storage/db.ts";
import { acquireInstanceLock } from "../src/storage/instance-lock.ts";

process.umask(0o077);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { env: { type: "string", default: "production" } } });
const config = loadConfig({ ...process.env, MEDIA_MANAGER_ENV: values.env });
const paths = existsSync(config.dataDir) ? prepareDataDir(config.dataDir) : dataPaths(config.dataDir);
const appVersion = (JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
const out = (s: string) => process.stdout.write(`${s}\n`);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function run(): Promise<void> {
  if (!existsSync(paths.database)) throw new BackupError(`No database in ${config.dataDir} yet.`);
  const [command = "create", ...args] = positionals;
  switch (command) {
    case "create": {
      // Safe while the app is running: SQLite's online backup takes a consistent snapshot.
      const db = openDatabase(paths.database);
      try {
        const m = await createBackup(db, paths, { reason: "manual", appVersion });
        out(`Backed up to ${join(paths.backups, m.id)} (${m.mediaFiles.length} photo files).`);
      } finally {
        db.close();
      }
      return;
    }
    case "list": {
      const all = await listBackups(paths);
      if (all.length === 0) {
        out("No backups yet.");
        return;
      }
      for (const b of all) {
        const own = await backupOwnBytes(join(paths.backups, b.id));
        out(`${b.id}  ${new Date(b.createdAt).toLocaleString()}  ${b.mediaFiles.length} files  ${mb(own)} extra`);
      }
      return;
    }
    case "verify": {
      const m = await verifyBackupById(paths, need(args[0], "backup name"));
      out(`OK: ${m.id} is complete and intact (${m.mediaFiles.length} photo files).`);
      return;
    }
    case "export": {
      const target = await exportBackup(paths, need(args[0], "backup name"), resolve(need(args[1], "destination folder")));
      out(`Exported and verified: ${target}`);
      return;
    }
    case "restore": {
      const source = need(args[0], "backup name or folder");
      const release = acquireLockOrExplain();
      try {
        let id = source;
        if (source.includes("/")) {
          // An exported backup: verify it, then bring it into the backups folder.
          const dir = resolve(source);
          const m = await verifyBackup(dir);
          id = m.id;
          const local = join(paths.backups, id);
          if (!existsSync(local)) await cp(dir, local, { recursive: true, errorOnExist: true, force: false });
          if (basename(dir) !== id) out(`Imported ${dir} as ${id}.`);
        }
        const { restored, safety } = await restoreBackup(paths, id, { appVersion });
        if (safety) out(`Saved the current state first: ${safety.id}`);
        out(`Restored ${restored.id} (made ${new Date(restored.createdAt).toLocaleString()}).`);
        out("Every account's schedules are paused until you review them in the app.");
      } finally {
        release();
      }
      return;
    }
    default:
      throw new BackupError(`Unknown command "${command}". Use create, list, verify, export or restore.`);
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new BackupError(`Missing ${what}.`);
  return v;
}

function acquireLockOrExplain(): () => void {
  try {
    return acquireInstanceLock(join(paths.root, "server.lock"));
  } catch {
    throw new BackupError("Media Manager is running. Stop it first (Ctrl+C, or `npm run service -- stop` if it runs in the background).");
  }
}

run().catch((err: unknown) => {
  process.stderr.write(`${err instanceof BackupError ? err.message : err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
