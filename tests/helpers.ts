import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.ts";
import { loadConfig, type Config } from "../src/server/config.ts";
import { createSessionStore, type SessionStore } from "../src/server/sessions.ts";
import { createMemoryStore } from "../src/storage/credentials.ts";
import { prepareDataDir } from "../src/storage/data-dir.ts";
import { openDatabase, type Db } from "../src/storage/db.ts";
import { migrate } from "../src/storage/migrate.ts";

export function tempDir(prefix = "mm-test-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export class FakeClock {
  t = Date.UTC(2026, 9, 29, 12, 0, 0);
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface TestApp {
  app: FastifyInstance;
  config: Config;
  db: Db;
  sessions: SessionStore;
  clock: FakeClock;
  logs: string[];
  cleanup: () => Promise<void>;
}

export async function createTestApp(
  overrides: Partial<Config> = {},
  extra: { credentials?: ReturnType<typeof createMemoryStore>; endpoints?: import("../src/platforms/http.ts").Endpoints } = {},
): Promise<TestApp> {
  const dir = tempDir();
  const config = { ...loadConfig({ MEDIA_MANAGER_ENV: "test", MEDIA_MANAGER_DATA_DIR: dir.path }), ...overrides };
  const paths = prepareDataDir(config.dataDir);
  const db = openDatabase(paths.database);
  migrate(db);
  const clock = new FakeClock();
  const sessions = createSessionStore(clock.now);
  const logs: string[] = [];
  const app = await buildApp({
    config,
    db,
    sessions,
    version: "0.0.0-test",
    logStream: { write: (line) => void logs.push(line) },
    credentials: extra.credentials ?? createMemoryStore(),
    now: () => new Date(clock.t),
    ...(extra.endpoints ? { endpoints: extra.endpoints } : {}),
  });
  return {
    app,
    config,
    db,
    sessions,
    clock,
    logs,
    cleanup: async () => {
      await app.close();
      db.close();
      dir.cleanup();
    },
  };
}

/** Headers a same-origin browser request would carry. */
export function sameOrigin(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", ...extra };
}

/** Exchanges a fresh launch token and returns the session cookie and CSRF token. */
export async function signIn(t: TestApp): Promise<{ cookie: string; csrf: string }> {
  const res = await t.app.inject({
    method: "GET",
    url: `/launch?token=${t.sessions.mintLaunchToken()}`,
    headers: { host: `127.0.0.1:${t.config.port}` },
  });
  const set = res.cookies.find((c) => c.name === "mm_session");
  if (!set) throw new Error("no session cookie");
  const cookie = `mm_session=${set.value}`;
  const session = await t.app.inject({
    method: "GET",
    url: "/api/session",
    headers: sameOrigin(t.config.port, { cookie }),
  });
  return { cookie, csrf: session.json<{ csrfToken: string }>().csrfToken };
}
