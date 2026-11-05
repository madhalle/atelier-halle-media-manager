// Full browser sign-in flow. The platforms' own sign-in pages are intercepted
// and answered with a redirect back to our callback, as the real platform
// would after the user approves; token exchange goes to loopback fakes.
import type { Page } from "@playwright/test";
import { BUSINESS_TOKEN, IG_SECRET, PIN_SECRET, R2 } from "../fake-providers.ts";
import { jpeg } from "../images.ts";
import { createAccountsViaApi, expect, test } from "./server.ts";

async function setUpPlatforms(page: Page) {
  await page.getByRole("button", { name: "Platform setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Platform setup" });
  const ig = dialog.locator("form").filter({ hasText: "Instagram (older Meta apps: Instagram Login)" });
  await ig.getByLabel("Instagram app ID").fill("9876543210123");
  await ig.getByLabel("Instagram app secret").fill(IG_SECRET);
  await ig.getByRole("button", { name: "Save" }).click();
  await expect(ig).toContainText("· set up");
  const pin = dialog.locator("form").filter({ hasText: "Pinterest" }).first();
  await pin.getByLabel("Pinterest app ID").fill("1234567890123");
  await pin.getByLabel("Pinterest app secret").fill(PIN_SECRET);
  await pin.getByRole("button", { name: "Save" }).click();
  await expect(pin).toContainText("· set up");
  return dialog;
}

/** Waits until a connected account's preview has finished loading, images included. */
async function previewSettled(page: Page) {
  const preview = page.locator(".account-preview");
  await expect(preview).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() => preview.locator("img").evaluateAll((imgs) => imgs.every((i) => (i as unknown as { complete: boolean }).complete)))
    .toBe(true);
}

/** Answers the platform's sign-in page by redirecting back with an authorization code. */
async function approveOn(page: Page, authorizeOrigin: string, code = "good-code") {
  await page.route(`${authorizeOrigin}/**`, async (route) => {
    const u = new URL(route.request().url());
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", u.searchParams.get("state")!);
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
}

test("platform secrets are write-only in the UI", async ({ page, server }) => {
  await server.signIn(page);
  const dialog = await setUpPlatforms(page);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Platform setup" }).click();
  const secretField = page.getByRole("dialog", { name: "Platform setup" }).getByLabel("Instagram app secret");
  await expect(secretField).toHaveValue("");
  await expect(secretField).toHaveAttribute("placeholder", /Saved in Keychain/);
  expect(await page.content()).not.toContain(IG_SECRET);
  await expect(page.getByRole("dialog", { name: "Platform setup" }).getByLabel("Redirect URI to register").first()).toHaveValue(
    `http://localhost:${new URL(server.origin).port}/oauth/instagram/callback`,
  );
});

test("connects an Instagram Business account through the real callback flow", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Business Instagram" }]);
  await page.reload();
  const dialog = await setUpPlatforms(page);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();

  await approveOn(page, "https://www.instagram.com");
  await page.getByRole("button", { name: "Connect Instagram account" }).click();

  // Back in the app on the canonical origin, with the code removed from the address bar.
  await expect(page.locator("main")).toContainText("Connected as @atelierhalle (business)", { timeout: 15_000 });
  await previewSettled(page);
  expect(page.url()).not.toContain("code=");
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  await expect(page.locator("main")).toContainText("Pending schedules are paused until you review them.");
  expect(await page.content()).not.toMatch(/IG-(LONG|SHORT)-/);
});

test("connects Instagram through a business portfolio token by choosing the account", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Second studio" }]);
  await page.reload();
  await page.getByRole("button", { name: "Platform setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Platform setup" });
  const biz = dialog.locator("form").filter({ hasText: "Instagram (Meta business portfolio)" });
  await biz.getByLabel("System-user access token").fill(BUSINESS_TOKEN);
  await biz.getByRole("button", { name: "Save" }).click();
  await expect(biz).toContainText("· set up");
  await expect(biz.getByLabel("System-user access token")).toHaveValue("");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();

  await page.getByRole("button", { name: "Connect Instagram account" }).click();
  await page.getByLabel("Instagram account").selectOption({ label: "@studio_second" });
  await page.getByRole("button", { name: "Connect this account" }).click();
  await expect(page.locator("main")).toContainText("Connected as @studio_second (business)");
  await previewSettled(page);
  expect(await page.content()).not.toContain(BUSINESS_TOKEN);
});

test("a connected account shows its profile and recent posts, proxied through the app", async ({ page, server, providers }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Studio" }]);
  await page.reload();
  await page.getByRole("button", { name: "Platform setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Platform setup" });
  const biz = dialog.locator("form").filter({ hasText: "Instagram (Meta business portfolio)" });
  await biz.getByLabel("System-user access token").fill(BUSINESS_TOKEN);
  await biz.getByRole("button", { name: "Save" }).click();
  await expect(biz).toContainText("· set up");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Connect Instagram account" }).click();
  await page.getByLabel("Instagram account").selectOption({ label: "@atelierhalle (Atelier Halle)" });
  await page.getByRole("button", { name: "Connect this account" }).click();

  const preview = page.locator(".account-preview");
  await expect(preview.getByRole("heading", { name: "Atelier Hallé" })).toBeVisible();
  await expect(preview).toContainText("Jewellery, made by hand.");
  await expect(preview.getByRole("link", { name: "View on Instagram ↗" })).toHaveAttribute("href", "https://www.instagram.com/atelierhalle/");
  const thumbs = preview.locator(".preview-grid img");
  await expect(thumbs).toHaveCount(3);
  // Images load from the app itself (strict CSP), never from the platform's CDN.
  await expect.poll(() => thumbs.first().evaluate((img) => (img as unknown as { complete: boolean; naturalWidth: number }).complete && (img as unknown as { naturalWidth: number }).naturalWidth)).toBe(360);
  for (const src of await thumbs.evaluateAll((imgs) => imgs.map((i) => (i as unknown as { src: string }).src))) {
    expect(new URL(src).origin).toBe(server.origin);
  }
  await previewSettled(page);
  expect(await page.content()).not.toContain(providers.state.cdn.origin);
});

test("connects by Instagram account ID when Meta lists no accounts", async ({ page, server, providers }) => {
  providers.state.fb.assigned = [];
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Studio" }]);
  await page.reload();
  await page.getByRole("button", { name: "Platform setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Platform setup" });
  const biz = dialog.locator("form").filter({ hasText: "Instagram (Meta business portfolio)" });
  await biz.getByLabel("System-user access token").fill(BUSINESS_TOKEN);
  await biz.getByRole("button", { name: "Save" }).click();
  await expect(biz).toContainText("· set up");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();

  await page.getByRole("button", { name: "Connect Instagram account" }).click();
  await page.getByLabel("Instagram account ID").fill("17841400000000001");
  await page.getByRole("button", { name: "Connect this account" }).click();
  await expect(page.locator("main")).toContainText("Connected as @atelierhalle (business)");
  await previewSettled(page);
});

test("refuses a personal Instagram account with an explanation", async ({ page, server, providers }) => {
  providers.state.ig.accountType = "PERSONAL";
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Personal Instagram" }]);
  await page.reload();
  const dialog = await setUpPlatforms(page);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await approveOn(page, "https://www.instagram.com");
  await page.getByRole("button", { name: "Connect Instagram account" }).click();
  await expect(page.getByRole("status")).toContainText("only allows publishing through the API from professional", { timeout: 15_000 });
});

test("connects Pinterest and disconnects with a clear follow-up", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "pinterest", displayName: "Atelier Halle Pinterest" }]);
  await page.reload();
  const dialog = await setUpPlatforms(page);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await approveOn(page, "https://www.pinterest.com");
  await page.getByRole("button", { name: "Connect Pinterest account" }).click();
  await expect(page.locator("main")).toContainText("Connected as @atelierhalle (business)", { timeout: 15_000 });
  await previewSettled(page);

  await page.getByRole("button", { name: "Disconnect…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator("main")).toContainText("doesn't let apps revoke their own access");
  await expect(page.locator("main")).toContainText("Disconnected");
});

test("creates a Pinterest board from the Pin editor and chooses it", async ({ page, server, providers }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "pinterest", displayName: "Atelier Halle Pinterest" }]);
  await page.reload();
  const dialog = await setUpPlatforms(page);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await approveOn(page, "https://www.pinterest.com");
  await page.getByRole("button", { name: "Connect Pinterest account" }).click();
  await expect(page.locator("main")).toContainText("Connected as @atelierhalle (business)", { timeout: 15_000 });
  await previewSettled(page);

  await page.getByRole("button", { name: "New post" }).click();
  const library = page.getByRole("dialog");
  await library.locator('input[type="file"]').setInputFiles([{ name: "ring.jpg", mimeType: "image/jpeg", buffer: await jpeg(1000, 1500) }]);
  await page.getByRole("button", { name: "Use for new post: ring.jpg" }).click();
  await expect(page.getByRole("heading", { name: /^Draft for / })).toBeVisible();

  await page.getByRole("button", { name: "New board…" }).click();
  await page.getByLabel("New board name").fill("Rings");
  await page.getByLabel("New board name").press("Enter"); // creates the board, doesn't submit the draft
  await expect(page.getByLabel("Board", { exact: true })).toHaveValue(/^\d+$/);
  await expect(page.getByLabel("Board", { exact: true }).locator("option:checked")).toHaveText("Rings");
  await expect(page.getByLabel("New board name")).toHaveCount(0);
  expect(providers.state.pin.boards.map((b) => b.name)).toContain("Rings");
});

test("tests the R2 connection from Platform setup without showing the secret", async ({ page, server, providers }) => {
  await server.signIn(page);
  await page.getByRole("button", { name: "Platform setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Platform setup" });
  const r2 = dialog.locator("form").filter({ hasText: "Cloudflare R2" });
  await expect(r2.getByRole("button", { name: "Test connection" })).toHaveCount(0);
  await r2.getByLabel("Cloudflare account ID").fill(R2.accountId);
  await r2.getByLabel("Bucket name").fill(R2.bucket);
  await r2.getByLabel("Access key ID").fill(R2.accessKeyId);
  await r2.getByLabel("Secret access key").fill(R2.secretAccessKey);
  await r2.getByRole("button", { name: "Save" }).click();
  await expect(r2).toContainText("· set up");
  await r2.getByRole("button", { name: "Test connection" }).click();
  await expect(r2.getByRole("status")).toContainText("Connection works");
  expect(providers.state.r2.objects.size).toBe(0);
  expect(await page.content()).not.toContain(R2.secretAccessKey);
});
