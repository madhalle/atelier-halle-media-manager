import type { Page } from "@playwright/test";
import { jpeg, png } from "../images.ts";
import { createAccountsViaApi, expect, test } from "./server.ts";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Accounts" });
const tab = (page: Page, name: string) => sidebar(page).getByRole("button", { name: new RegExp(`^${name} `) });

async function uploadInLibrary(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles(files);
  await expect(dialog.getByText(/added|not added|already/)).toBeVisible();
}

async function newPostFromUpload(page: Page, file: { name: string; buffer: Buffer }) {
  await page.getByRole("button", { name: "New post" }).click();
  await uploadInLibrary(page, [{ name: file.name, mimeType: "image/jpeg", buffer: file.buffer }]);
  await page.getByRole("button", { name: `Use for new post: ${file.name}` }).click();
  await expect(page.getByRole("heading", { name: /^Draft for / })).toBeVisible();
}

async function previewLoaded(page: Page) {
  const img = page.locator(".preview img");
  type Img = { complete: boolean; naturalWidth: number; naturalHeight: number; src: string };
  await expect.poll(() => img.evaluate((el) => (el as unknown as Img).complete && (el as unknown as Img).naturalWidth)).toBeGreaterThan(0);
  return img.evaluate((el) => {
    const i = el as unknown as Img;
    return { w: i.naturalWidth, h: i.naturalHeight, src: i.src };
  });
}

test("uploads several photos, reports rejected files, and creates a draft", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Business Instagram" }]);
  await page.reload();

  await page.getByRole("button", { name: "Photo library" }).click();
  await uploadInLibrary(page, [
    { name: "dress.jpg", mimeType: "image/jpeg", buffer: await jpeg(1080, 1350, { color: "#a07050" }) },
    { name: "studio.png", mimeType: "image/png", buffer: await png(1200, 1200) },
    { name: "notes.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not a photo") },
  ]);
  const dialog = page.getByRole("dialog", { name: "Photo library" });
  await expect(dialog).toContainText("2 photos added.");
  await expect(dialog).toContainText("notes.jpg: This file isn't a JPEG, PNG or WebP image.");
  await expect(dialog.locator(".library-grid li")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "New post" }).click();
  await page.getByRole("button", { name: "Use for new post: dress.jpg" }).click();
  await expect(page.getByRole("heading", { name: "Draft for Business Instagram" })).toBeVisible();
  await page.getByLabel("Caption").fill("New linen collection #atelierhalle @friend");
  await expect(page.getByText("42/2200 characters · 1/30 hashtags · 1/20 mentions")).toBeVisible();
  await page.getByLabel("Alt text").fill("Linen dress on a wooden hanger");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Nothing blocks this post.")).toBeVisible();

  await page.getByRole("button", { name: "← Back to posts" }).click();
  await expect(page.locator(".post-card")).toHaveCount(1);
  await expect(page.locator(".post-card")).toContainText("New linen collection #atelierhalle @friend");
  await expect(page.getByRole("button", { name: /^Drafts 1$/ })).toBeVisible();

  // Survives a reload, including the open-composer route.
  await page.locator(".post-card").click();
  await page.reload();
  await expect(page.getByLabel("Caption")).toHaveValue("New linen collection #atelierhalle @friend");
});

test("Instagram requires an explicit crop for out-of-range photos and previews the real derivative", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "IG" }]);
  await page.reload();
  await newPostFromUpload(page, { name: "tall.jpg", buffer: await jpeg(1000, 2000) });

  await expect(page.locator(".composer-checks")).toContainText("Choose a crop");
  const original = await previewLoaded(page);
  expect(original).toMatchObject({ w: 1000, h: 2000 });

  await page.getByRole("radio", { name: "Portrait 4:5" }).check();
  await expect.poll(async () => (await previewLoaded(page)).src).not.toBe(original.src);
  expect(await previewLoaded(page)).toMatchObject({ w: 1000, h: 1250 });
  await page.getByLabel("Vertical position").fill("0");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Nothing blocks this post.")).toBeVisible();
});

test("copies to other accounts as independent drafts; archived accounts are excluded", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [
    { platform: "instagram", displayName: "Business Instagram" },
    { platform: "pinterest", displayName: "Atelier Halle Pinterest" },
    { platform: "instagram", displayName: "Personal Instagram" },
    { platform: "pinterest", displayName: "Old Pins" },
  ]);
  await page.reload();
  await page.getByRole("button", { name: "Settings for Old Pins" }).click();
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive account" }).click();
  await tab(page, "Business Instagram").click();

  await newPostFromUpload(page, { name: "shared.jpg", buffer: await jpeg(1080, 1080) });
  await page.getByLabel("Caption").fill("Shared caption");
  await page.getByRole("button", { name: "Copy to accounts…" }).click(); // saves first

  const dialog = page.getByRole("dialog", { name: "Copy to accounts" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await expect(dialog).toContainText("Atelier Halle Pinterest (Pinterest · Not connected)");
  await expect(dialog).not.toContainText("Old Pins");
  await expect(dialog).not.toContainText("Business Instagram (");
  await dialog.getByRole("checkbox", { name: /Atelier Halle Pinterest/ }).check();
  await dialog.getByRole("checkbox", { name: /Personal Instagram/ }).check();
  await dialog.getByRole("button", { name: "Create 2 drafts" }).click();
  await expect(page.getByRole("status")).toContainText("Created 2 independent drafts on: Atelier Halle Pinterest, Personal Instagram. Nothing was scheduled.");

  await page.getByRole("button", { name: "← Back to posts" }).click();
  await tab(page, "Atelier Halle Pinterest").click();
  await page.locator(".post-card").click();
  await expect(page.getByLabel("Description")).toHaveValue("Shared caption");
  await expect(page.getByLabel("Caption")).toHaveCount(0); // Pinterest shows only its own fields
  await page.getByLabel("Description").fill("Pinterest-only description");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".composer-checks")).toContainText("Choose a board");

  await page.getByRole("button", { name: "← Back to posts" }).click();
  await tab(page, "Business Instagram").click();
  await expect(page.locator(".post-card")).toContainText("Shared caption");
});

test("switching accounts or leaving the composer never silently drops unsaved text", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [
    { platform: "instagram", displayName: "Alpha" },
    { platform: "pinterest", displayName: "Beta" },
  ]);
  await page.reload();
  await newPostFromUpload(page, { name: "a.jpg", buffer: await jpeg(1080, 1080) });
  await page.getByLabel("Caption").fill("Unsaved words");

  await tab(page, "Beta").click();
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("Caption")).toHaveValue("Unsaved words");

  await page.getByRole("button", { name: "← Back to posts" }).click();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "← Back to posts" }).click();
  await expect(page.locator(".post-card")).toContainText("Unsaved words");
});

test("deletes a draft but keeps its photo in the library", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "pinterest", displayName: "Pins" }]);
  await page.reload();
  await newPostFromUpload(page, { name: "keep.jpg", buffer: await jpeg(1000, 1500) });
  await page.getByRole("button", { name: "Delete draft…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete draft" }).click();
  await expect(page.getByRole("status")).toContainText("Draft deleted");
  await expect(page.locator(".post-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Photo library" }).click();
  await expect(page.getByRole("dialog").locator(".library-grid li")).toHaveCount(1);
});

test("captions are rendered as text, never as markup", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "IG" }]);
  await page.reload();
  await newPostFromUpload(page, { name: "x.jpg", buffer: await jpeg(1080, 1080) });
  const payload = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
  await page.getByLabel("Caption").fill(payload);
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "← Back to posts" }).click();
  await expect(page.locator(".post-card .caption-preview")).toHaveText(payload);
  expect(await page.evaluate(() => (globalThis as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(page.locator(".post-card b")).toHaveCount(0);
});
