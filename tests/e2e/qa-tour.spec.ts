// A walkthrough of the main screens for visual QA: the landing page, adding an
// Instagram and a Pinterest account (against simulated platforms), and both tabs
// with drafted posts. Named screenshots land in the HTML report (`npm run qa`).
import type { Page, TestInfo } from "@playwright/test";
import sharp from "sharp";
import { BUSINESS_TOKEN, PIN_SECRET } from "../fake-providers.ts";
import { expect, test } from "./server.ts";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Accounts" });

/** Screenshots the whole main panel: it scrolls inside a full-height layout, so the window grows to fit it first. */
async function snap(page: Page, testInfo: TestInfo, name: string) {
  const size = page.viewportSize()!;
  const contentHeight = await page.locator("main").evaluate((el) => el.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, contentHeight) });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await page.setViewportSize(size);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** A soft two-colour gradient, so drafts look like photos rather than flat swatches. */
function photo(from: string, to: string, width: number, height: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.62}" cy="${height * 0.42}" r="${Math.min(width, height) * 0.22}" fill="#ffffff" fill-opacity="0.35"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

async function startDraft(page: Page, name: string, buffer: Buffer) {
  await page.getByRole("button", { name: "New post" }).click();
  const library = page.getByRole("dialog");
  await library.locator('input[type="file"]').setInputFiles([{ name, mimeType: "image/jpeg", buffer }]);
  await page.getByRole("button", { name: `Use for new post: ${name}` }).click();
  await expect(page.getByRole("heading", { name: /^Draft for / })).toBeVisible();
}

/** Drafts save themselves shortly after typing stops; wait for that, then leave. */
async function saveAndGoBack(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible();
  await page.getByRole("button", { name: "← Back to posts" }).click();
}

/** Waits for the account preview to finish loading and every image on the page to arrive. */
async function imagesLoaded(page: Page) {
  await expect(page.locator(".account-preview")).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() => page.locator("main img").evaluateAll((imgs) => imgs.every((i) => (i as unknown as { complete: boolean }).complete)))
    .toBe(true);
}

test("QA tour: landing page, adding accounts, and tabs with drafts", async ({ page, server }, testInfo) => {
  test.setTimeout(90_000); // a long walkthrough, not one quick check
  await server.signIn(page);
  await expect(page.getByRole("heading", { name: "Welcome to Media Manager" })).toBeVisible();
  await snap(page, testInfo, "01-landing-page");

  // Add an Instagram account through a business-portfolio token.
  await page.getByRole("button", { name: "Add an account" }).click();
  const add = page.getByRole("dialog", { name: "Add account" });
  await expect(add.getByRole("button", { name: "Pinterest" })).toBeVisible();
  await snap(page, testInfo, "02-add-account-choose-platform");
  await add.getByRole("button", { name: "Instagram" }).click();
  await expect(add.getByLabel("System-user access token")).toBeVisible();
  await snap(page, testInfo, "03-add-account-instagram-setup");
  await add.getByLabel("System-user access token").fill(BUSINESS_TOKEN);
  await add.getByRole("button", { name: "Save" }).click();
  await add.getByRole("button", { name: "Connect Instagram account" }).click();
  await add.getByLabel("Instagram account").selectOption({ label: "@atelierhalle (Atelier Halle)" });
  await snap(page, testInfo, "04-add-account-instagram-choose-account");
  await add.getByRole("button", { name: "Connect this account" }).click();
  await expect(add).toBeHidden();
  await expect(page.locator("main")).toContainText("Connected as @atelierhalle (business)");
  await imagesLoaded(page);
  await snap(page, testInfo, "05-instagram-connected");

  // Draft two Instagram posts.
  await startDraft(page, "linen-dress.jpg", await photo("#d9b99b", "#8c6a4f", 1080, 1350));
  await page.getByLabel("Caption").fill("The linen collection is here. Made slowly, by hand. #atelierhalle");
  await page.getByLabel("Alt text").fill("Linen dress on a wooden hanger");
  await saveAndGoBack(page);
  await startDraft(page, "silver-rings.jpg", await photo("#c9d3dc", "#6d7f91", 1080, 1080));
  await page.getByLabel("Caption").fill("Stacking rings in recycled silver.");
  await snap(page, testInfo, "06-instagram-composer");
  await saveAndGoBack(page);
  await expect(page.locator(".post-card")).toHaveCount(2);
  await imagesLoaded(page);
  await snap(page, testInfo, "07-instagram-tab-with-drafts");

  // Add a Pinterest account: app details, then Pinterest's sign-in (answered by the test).
  await page.route("https://www.pinterest.com/**", async (route) => {
    const url = new URL(route.request().url());
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "good-code");
    back.searchParams.set("state", url.searchParams.get("state")!);
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.getByRole("button", { name: "+ Add account" }).click();
  await add.getByRole("button", { name: "Pinterest" }).click();
  await add.getByLabel("Pinterest app ID").fill("1234567890123");
  await add.getByLabel("Pinterest app secret").fill(PIN_SECRET);
  await snap(page, testInfo, "08-add-account-pinterest-setup");
  await add.getByRole("button", { name: "Save" }).click();
  await add.getByRole("button", { name: "Connect Pinterest account" }).click();
  await expect(page.locator("main")).toContainText("Connected as @atelierhalle (business)", { timeout: 15_000 });
  await expect(sidebar(page).locator(".platform-icon.pinterest")).toBeVisible();
  await expect(page.locator(".account-preview")).toHaveAttribute("aria-busy", "false");

  // Draft two Pins, the first on a new board.
  await startDraft(page, "gold-earrings.jpg", await photo("#f1d9a7", "#b9894a", 1000, 1500));
  await page.getByLabel("Title").fill("Hand-hammered gold earrings");
  await page.getByLabel("Description").fill("Light enough to wear every day.");
  await page.getByRole("button", { name: "New board…" }).click();
  await page.getByLabel("New board name").fill("Earrings");
  await page.getByLabel("New board name").press("Enter");
  await expect(page.getByLabel("Board", { exact: true }).locator("option:checked")).toHaveText("Earrings");
  await snap(page, testInfo, "09-pinterest-composer");
  await saveAndGoBack(page);
  await startDraft(page, "studio-bench.jpg", await photo("#e3d5ca", "#9a7b6a", 1000, 1500));
  await page.getByLabel("Title").fill("A morning at the bench");
  await saveAndGoBack(page);
  await expect(page.locator(".post-card")).toHaveCount(2);
  await imagesLoaded(page);
  await snap(page, testInfo, "10-pinterest-tab-with-drafts");
});
