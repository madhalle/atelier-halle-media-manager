// Forward-only, versioned SQL migrations from the `migrations` directory.
// Files are named `NNNN_description.sql`; each runs in its own transaction.
// Applied migrations are checksummed so edits to shipped files are detected.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "..", "..", "migrations");

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((file) => {
      const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
      if (!match) throw new Error(`Invalid migration file name: ${file}`);
      const sql = readFileSync(join(dir, file), "utf8");
      return {
        version: Number(match[1]),
        name: match[2]!,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration versions must be contiguous; expected ${i + 1}, found ${m.version}`);
  });
  return migrations;
}

interface AppliedRow {
  version: number;
  checksum: string;
}

/** Applies pending migrations. Returns the versions applied in this call. */
export function migrate(db: Db, migrations = loadMigrations()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const applied = new Map(
    (db.prepare("SELECT version, checksum FROM schema_migrations").all() as AppliedRow[]).map((r) => [r.version, r.checksum]),
  );
  const known = new Set(migrations.map((m) => m.version));
  for (const version of applied.keys()) {
    if (!known.has(version)) {
      throw new Error(`Database has migration ${version}, which this version of the app does not know. Refusing to start.`);
    }
  }

  const record = db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)");
  const ran: number[] = [];
  for (const m of migrations) {
    const existing = applied.get(m.version);
    if (existing !== undefined) {
      if (existing !== m.checksum) throw new Error(`Migration ${m.version}_${m.name} was modified after being applied`);
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, m.checksum, new Date().toISOString());
    })();
    ran.push(m.version);
  }
  return ran;
}

/** Migrations not yet applied to an existing database (0 for a brand-new one). */
export function pendingMigrations(db: Db, migrations = loadMigrations()): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return 0;
  const applied = (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
  return Math.max(0, migrations.length - applied);
}
