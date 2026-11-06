import { createAccountsViaApi, expect, test } from "./server.ts";

const sidebar = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Accounts" });
const tab = (page: import("@playwright/test").Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name} `) });

test("a fresh install welcomes you with an Add an account action", async ({ page, server }) => {
  await server.signIn(page);
  await expect(page.getByRole("heading", { name: "Welcome to Media Manager" })).toBeVisible();
  await expect(sidebar(page)).toContainText("No accounts yet");
  await page.getByRole("button", { name: "Add an account" }).click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await expect(dialog.getByRole("button", { name: "Instagram" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Pinterest" })).toBeVisible();
});

test("creates accounts on both platforms in a vertical sidebar and switches galleries", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [
    { platform: "instagram", displayName: "Personal Instagram" },
    { platform: "instagram", displayName: "Business Instagram" },
    { platform: "pinterest", displayName: "Atelier Halle Pinterest" },
  ]);
  await page.reload();

  await tab(page, "Atelier Halle Pinterest").click();
  await expect(page.getByRole("heading", { level: 1, name: "Atelier Halle Pinterest" })).toBeVisible();
  await expect(tab(page, "Atelier Halle Pinterest")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("main")).toContainText("Not connected");
  await expect(page.locator("main")).toContainText("Won’t publish automatically");

  // Tabs are stacked vertically in one column.
  const boxes = await Promise.all(
    ["Personal Instagram", "Business Instagram", "Atelier Halle Pinterest"].map((n) => tab(page, n).boundingBox()),
  );
  expect(boxes[0]!.x).toBe(boxes[1]!.x);
  expect(boxes[1]!.x).toBe(boxes[2]!.x);
  expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);

  // Sidebar ≈ 1/6 of the page, main ≈ 5/6.
  const aside = (await page.locator("aside#sidebar").boundingBox())!;
  const main = (await page.locator("main#main").boundingBox())!;
  expect(main.x).toBeGreaterThanOrEqual(aside.x + aside.width - 1);
  expect(main.width / aside.width).toBeGreaterThan(4.5);
  expect(main.width / aside.width).toBeLessThan(5.5);

  await tab(page, "Personal Instagram").click();
  await expect(page.getByRole("heading", { level: 1, name: "Personal Instagram" })).toBeVisible();
  await expect(tab(page, "Personal Instagram")).toHaveAttribute("aria-current", "page");
  await expect(tab(page, "Atelier Halle Pinterest")).not.toHaveAttribute("aria-current", "page");

  // Selection survives a reload.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Personal Instagram" })).toBeVisible();
});

test("accounts and order persist across a server restart", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [
    { platform: "pinterest", displayName: "Pins A" },
    { platform: "instagram", displayName: "IG B" },
  ]);
  await page.reload();
  await page.getByRole("button", { name: "Settings for IG B" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(sidebar(page).locator(".account-name")).toHaveText(["IG B", "Pins A"]);

  await server.stop();
  await server.start();
  await server.signIn(page);
  await expect(sidebar(page).locator(".account-name")).toHaveText(["IG B", "Pins A"]);
});

test("keyboard: arrow keys move between accounts and the settings menu reorders", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [
    { platform: "instagram", displayName: "One" },
    { platform: "pinterest", displayName: "Two" },
    { platform: "instagram", displayName: "Three" },
  ]);
  await page.reload();

  await tab(page, "One").focus();
  await page.keyboard.press("ArrowDown");
  await expect(tab(page, "Two")).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab(page, "Three")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Three" })).toBeVisible();

  const menuButton = page.getByRole("button", { name: "Settings for One" });
  await menuButton.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "One settings" });
  // Move up is disabled for the first item, so focus starts on Move down.
  await expect(menu.getByRole("menuitem", { name: "Move down" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sidebar(page).locator(".account-name")).toHaveText(["Two", "One", "Three"]);
  await expect(menuButton).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();
});

test("archive keeps the account restorable and restore requires schedule review", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [
    { platform: "instagram", displayName: "Keep" },
    { platform: "pinterest", displayName: "Old Pins" },
  ]);
  await page.reload();
  await page.getByRole("button", { name: "Settings for Old Pins" }).click();
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  const confirm = page.getByRole("dialog", { name: "Archive “Old Pins”?" });
  await expect(confirm).toContainText("may still go out");
  await confirm.getByRole("button", { name: "Archive account" }).click();

  await expect(sidebar(page).locator(".account-list:not(.archived) .account-name")).toHaveText(["Keep"]);
  await sidebar(page).getByRole("button", { name: "Archived (1)" }).click();
  await tab(page, "Old Pins").click();
  await expect(page.locator("main")).toContainText("Archived");
  await page.getByRole("button", { name: "Restore account" }).click();
  await expect(page.locator("main")).toContainText("Pending schedules are paused until you review them.");
  await expect(sidebar(page).locator(".account-list:not(.archived) .account-name")).toHaveText(["Keep", "Old Pins"]);
});

test("a long account list scrolls while Add account stays reachable", async ({ page, server }) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await server.signIn(page);
  await createAccountsViaApi(
    page,
    Array.from({ length: 30 }, (_, i) => ({ platform: i % 2 ? "pinterest" : "instagram", displayName: `Account ${i + 1}` }) as const),
  );
  await page.reload();
  const add = sidebar(page).locator("xpath=..").getByRole("button", { name: "+ Add account" });
  await expect(add).toBeInViewport();
  const scroller = page.locator(".account-scroll");
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await tab(page, "Account 30").scrollIntoViewIfNeeded();
  await tab(page, "Account 30").click();
  await expect(page.getByRole("heading", { level: 1, name: "Account 30" })).toBeVisible();
  await expect(add).toBeInViewport();
});

test("narrow screens use a drawer and keep the gallery usable", async ({ page, server }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await server.signIn(page);
  await createAccountsViaApi(page, [
    { platform: "instagram", displayName: "Phone IG" },
    { platform: "pinterest", displayName: "Phone Pins" },
  ]);
  await page.reload();

  await expect(sidebar(page)).toBeHidden();
  await expect(page.getByRole("heading", { name: "Posts" })).toBeInViewport();
  const toggle = page.getByRole("button", { name: "☰ Accounts" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await tab(page, "Phone Pins").click();
  await expect(sidebar(page)).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Phone Pins" })).toBeFocused();

  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(sidebar(page)).toBeHidden();
});

test("unauthenticated browsers see sign-in guidance, not data", async ({ page, server }) => {
  await page.goto(server.origin);
  await expect(page.getByText("This browser is not signed in")).toBeVisible();
});

test("backs up from the Backups panel and checks the backup", async ({ page, server }) => {
  await server.signIn(page);
  await page.getByRole("button", { name: "Backups" }).click();
  const dialog = page.getByRole("dialog", { name: "Backups and service" });
  await expect(dialog).toContainText("Running from Terminal.");
  // The server made its daily backup when it started.
  await expect(dialog.locator("table.backups tbody tr")).toHaveCount(1);
  await expect(dialog.locator("table.backups tbody tr")).toContainText("Daily");
  await dialog.getByRole("button", { name: "Back up now" }).click();
  await expect(dialog.getByRole("status").first()).toContainText("Backed up.");
  await expect(dialog.locator("table.backups tbody tr")).toHaveCount(2);
  await expect(dialog.locator("table.backups tbody tr").first()).toContainText("Manual");
  await dialog.getByRole("button", { name: /^Check backup from/ }).first().click();
  await expect(dialog).toContainText("Intact: database verified");
  await dialog.locator("summary").click();
  await expect(dialog.locator("pre").last()).toContainText(/npm run backup -- restore \d{8}-\d{6}-\d{3}-manual --env test/);
});

test("clicking outside a dialog closes it, like Escape; clicks inside don't", async ({ page, server }) => {
  await server.signIn(page);
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await page.getByRole("button", { name: "+ Add account" }).first().click();
  await expect(dialog).toBeVisible();

  // Inside, including dragging from inside out to the backdrop, keeps it open.
  await dialog.getByRole("heading", { name: "Add account" }).click();
  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  // Outside on the backdrop closes it.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
});

test("clicking outside a confirmation cancels it", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Keep me" }]);
  await page.reload();
  await page.getByRole("button", { name: "Archive account…" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(confirm).toBeHidden();
  await expect(tab(page, "Keep me")).toBeVisible(); // not archived
  await expect(page.locator("main")).not.toContainText("Archived");
});
