// SQLite connection setup. All SQL lives in src/storage.
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (existsSync(f)) chmodSync(f, 0o600);
  }
  return db;
}
