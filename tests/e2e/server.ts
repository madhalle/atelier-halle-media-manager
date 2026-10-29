// Starts the real server process against an isolated temporary data directory.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface TestServer {
  origin: string;
  dataDir: string;
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

export function createTestServer(port: number): TestServer {
  const dataDir = mkdtempSync(join(tmpdir(), "mm-e2e-"));
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let output = "";

  return {
    origin,
    dataDir,
    async start() {
      child = spawn(process.execPath, ["src/server/main.ts"], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          MEDIA_MANAGER_ENV: "test",
          MEDIA_MANAGER_DATA_DIR: dataDir,
          MEDIA_MANAGER_PORT: String(port),
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

export const test = base.extend<{ server: TestServer }>({
  // Every test also fails on browser console errors, including CSP violations.
  page: async ({ page }, use) => {
    const problems: string[] = [];
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      // The signed-out check intentionally receives a 401.
      if (msg.type() === "error" && !msg.text().includes("401")) problems.push(`console: ${msg.text()}`);
    });
    await use(page);
    expect(problems).toEqual([]);
  },
  // Playwright requires a destructuring pattern for fixture dependencies.
  // oxlint-disable-next-line no-empty-pattern
  server: async ({}, use, testInfo) => {
    const server = createTestServer(4900 + testInfo.workerIndex);
    await server.start();
    await use(server);
    await server.stop();
    rmSync(server.dataDir, { recursive: true, force: true });
  },
});

export { expect };

/** Creates accounts through the real API using the page's session. */
export async function createAccountsViaApi(page: Page, accounts: { platform: "instagram" | "pinterest"; displayName: string }[]) {
  await page.evaluate(async (list) => {
    const { csrfToken } = (await (await fetch("/api/session")).json()) as { csrfToken: string };
    for (const a of list) {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(a),
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
    }
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
