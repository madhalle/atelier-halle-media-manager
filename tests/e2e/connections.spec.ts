// Full browser sign-in flow. The platforms' own sign-in pages are intercepted
// and answered with a redirect back to our callback, as the real platform
// would after the user approves; token exchange goes to loopback fakes.
import type { Page } from "@playwright/test";
import { IG_SECRET, PIN_SECRET } from "../fake-providers.ts";
import { createAccountsViaApi, expect, test } from "./server.ts";

async function setUpPlatforms(page: Page) {
  await page.getByRole("button", { name: "Platform setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Platform setup" });
  const ig = dialog.locator("form").filter({ hasText: "Instagram (Meta app)" });
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
  expect(page.url()).not.toContain("code=");
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  await expect(page.locator("main")).toContainText("Pending schedules are paused until you review them.");
  expect(await page.content()).not.toMatch(/IG-(LONG|SHORT)-/);
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

  await page.getByRole("button", { name: "Disconnect…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator("main")).toContainText("doesn't let apps revoke their own access");
  await expect(page.locator("main")).toContainText("Disconnected");
});
