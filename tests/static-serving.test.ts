import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, tempDir, type TestApp } from "./helpers.ts";

let t: TestApp | undefined;
let web: ReturnType<typeof tempDir> | undefined;
afterEach(async () => {
  await t?.cleanup();
  web?.cleanup();
});

async function withBuiltUi(): Promise<TestApp> {
  web = tempDir("mm-web-");
  const root = join(web.path, "web");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>ui</title>");
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  // A secret beside (not inside) the web root must stay unreachable.
  writeFileSync(join(web.path, "secret.txt"), "top secret");
  return createTestApp({ webRoot: root });
}

describe("built UI serving", () => {
  it("serves the UI and assets from the same origin as the API", async () => {
    t = await withBuiltUi();
    const host = `127.0.0.1:${t.config.port}`;
    const page = await t.app.inject({ method: "GET", url: "/", headers: { host } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<title>ui</title>");
    expect(page.headers["content-security-policy"]).toBeDefined();
    const asset = await t.app.inject({ method: "GET", url: "/assets/app.js", headers: { host } });
    expect(asset.statusCode).toBe(200);
  });

  it("falls back to index.html for client routes but not for API paths", async () => {
    t = await withBuiltUi();
    const host = `127.0.0.1:${t.config.port}`;
    const route = await t.app.inject({ method: "GET", url: "/accounts/abc", headers: { host, accept: "text/html" } });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("<title>ui</title>");
    const api = await t.app.inject({ method: "GET", url: "/api/nope", headers: { host, accept: "text/html" } });
    expect(api.statusCode).not.toBe(200);
  });

  it.each(["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt"])(
    "blocks path traversal: %s",
    async (url) => {
      t = await withBuiltUi();
      const res = await t.app.inject({ method: "GET", url, headers: { host: `127.0.0.1:${t.config.port}` } });
      expect(res.body).not.toContain("top secret");
    },
  );

  it("explains how to build when the UI is missing", async () => {
    web = tempDir("mm-web-");
    t = await createTestApp({ webRoot: join(web.path, "missing") });
    const res = await t.app.inject({
      method: "GET",
      url: "/",
      headers: { host: `127.0.0.1:${t.config.port}`, accept: "text/html" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("npm run build");
  });
});
