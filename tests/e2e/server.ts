// Starts the real server process against an isolated temporary data directory.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { startFakeProviders, type FakeProviders } from "../fake-providers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface TestServer {
  origin: string;
  dataDir: string;
  /** Connects an account to a SIMULATED identity via the dev-only script. */
  fakeConnect: (accountId: string) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  signIn: (page: Page) => Promise<void>;
}

async function waitForHealth(origin: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

export function createTestServer(port: number, providers: FakeProviders): TestServer {
  const dataDir = mkdtempSync(join(tmpdir(), "mm-e2e-"));
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let output = "";

  return {
    origin,
    dataDir,
    fakeConnect(accountId) {
      execFileSync(process.execPath, ["scripts/dev-fake-connect.ts", "--env", "test", "--account", accountId], {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MEDIA_MANAGER_DATA_DIR: dataDir },
      });
    },
    async start() {
      child = spawn(process.execPath, ["src/server/main.ts"], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          MEDIA_MANAGER_ENV: "test",
          MEDIA_MANAGER_DATA_DIR: dataDir,
          MEDIA_MANAGER_PORT: String(port),
          // Simulated platforms, a fast scheduler and no minimum lead time, so
          // publishing flows complete in seconds. Never possible in production.
          MEDIA_MANAGER_FAKE_PLATFORMS: "enabled",
          MEDIA_MANAGER_SCHEDULER_INTERVAL_MS: "1000",
          MEDIA_MANAGER_MIN_LEAD_SECONDS: "-300",
          // Real platform calls go to loopback fakes; the browser's trips to the
          // platforms' sign-in pages are intercepted by the tests.
          MEDIA_MANAGER_TEST_ENDPOINTS: JSON.stringify({ ...providers.endpoints, r2: providers.endpoints.r2("x") }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (d) => (output += d));
      child.stderr?.on("data", (d) => (output += d));
      try {
        await waitForHealth(origin);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n${output}`);
      }
    },
    async stop() {
      if (!child) return;
      const c = child;
      child = null;
      await new Promise<void>((r) => {
        c.once("exit", () => r());
        c.kill("SIGTERM");
      });
    },
    async signIn(page) {
      const html = readFileSync(join(dataDir, "launch.html"), "utf8");
      const url = /url=(http[^"]+)"/.exec(html)?.[1];
      if (!url) throw new Error("no launch URL");
      await page.goto(url);
      await expect(page).not.toHaveURL(/token=/);
    },
  };
}

export const test = base.extend<{ server: TestServer; providers: FakeProviders }>({
  // oxlint-disable-next-line no-empty-pattern
  providers: async ({}, use) => {
    const p = await startFakeProviders();
    await use(p);
    await p.close();
  },
  // Every test also fails on browser console errors, including CSP violations.
  page: async ({ page }, use) => {
    const problems: string[] = [];
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      // Expected API answers (401 when signed out, 409 for daylight-saving conflicts) are logged by
      // Chrome as resource errors; anything else, including CSP violations, fails the test.
      const expected = /Failed to load resource: the server responded with a status of (401|409)/.test(msg.text());
      if (msg.type() === "error" && !expected) problems.push(`console: ${msg.text()}`);
    });
    await use(page);
    expect(problems).toEqual([]);
  },
  server: async ({ providers }, use, testInfo) => {
    const server = createTestServer(4900 + testInfo.workerIndex, providers);
    await server.start();
    await use(server);
    await server.stop();
    rmSync(server.dataDir, { recursive: true, force: true });
  },
});

export { expect };

/** Creates accounts through the real API using the page's session. */
export async function createAccountsViaApi(page: Page, accounts: { platform: "instagram" | "pinterest"; displayName: string }[]): Promise<string[]> {
  return page.evaluate(async (list) => {
    const ids: string[] = [];
    const { csrfToken } = (await (await fetch("/api/session")).json()) as { csrfToken: string };
    for (const a of list) {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(a),
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      ids.push(((await res.json()) as { account: { id: string } }).account.id);
    }
    return ids;
  }, accounts);
}

export async function addAccountViaUi(page: Page, platform: "Instagram" | "Pinterest", name: string) {
  await page.getByRole("button", { name: "+ Add account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await dialog.getByRole("radio", { name: platform }).check();
  await dialog.getByLabel("Display name").fill(name);
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden();
}
