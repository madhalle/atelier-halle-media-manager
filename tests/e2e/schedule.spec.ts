import type { Page } from "@playwright/test";
import { jpeg } from "../images.ts";
import { createAccountsViaApi, expect, test } from "./server.ts";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Accounts" });
const tab = (page: Page, name: string) => sidebar(page).getByRole("button", { name: new RegExp(`^${name} `) });

/** The current minute as wall-clock time in New York, i.e. due immediately. */
function nowInNewYork(): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function draftWithCaption(page: Page, caption: string, name = "photo.jpg") {
  await page.getByRole("button", { name: "New post" }).click();
  await page.getByRole("dialog").locator('input[type="file"]').setInputFiles([
    { name, mimeType: "image/jpeg", buffer: await jpeg(1080, 1080, { color: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}` }) },
  ]);
  await page.getByRole("button", { name: `Use for new post: ${name}` }).click();
  await page.getByLabel("Caption").fill(caption);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
}

async function scheduleAt(page: Page, date: string, time: string) {
  const panel = page.locator(".schedule-panel");
  await panel.getByLabel("Date", { exact: true }).fill(date);
  await panel.getByLabel("Time", { exact: true }).fill(time);
  await panel.getByRole("button", { name: /^(Schedule|Reschedule)$/ }).click();
}

async function connectedInstagram(page: Page, server: { fakeConnect: (id: string) => void }) {
  const [id] = await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Business Instagram" }]);
  server.fakeConnect(id!);
  await page.reload();
  // Connecting always pauses schedules for review first.
  await page.getByRole("button", { name: "Mark schedules reviewed" }).click();
  await expect(page.locator("main")).not.toContainText("Won’t publish automatically");
}

test("a due post publishes (simulated) with the backend alone, and history records it", async ({ page, server }) => {
  await server.signIn(page);
  await connectedInstagram(page, server);
  await expect(page.getByRole("status").filter({ hasText: "Simulated publishing is on" })).toBeVisible();
  await draftWithCaption(page, "Due now");
  const { date, time } = nowInNewYork();
  await scheduleAt(page, date, time);

  await expect(page.locator(".schedule-panel")).toContainText("Simulated publish", { timeout: 20_000 });
  await expect(page.locator(".schedule-panel")).toContainText("nothing was actually posted");
  await page.getByText("Publishing history").click();
  await expect(page.locator(".history")).toContainText("Published");
  await expect(page.locator(".history")).toContainText("simulated");
  await expect(page.getByLabel("Caption")).toBeDisabled();

  await page.getByRole("button", { name: "← Back to posts" }).click();
  await expect(page.getByRole("button", { name: /^Published 1$/ })).toBeVisible();
  await expect(page.locator(".post-card")).toContainText("simulated");
});

test("closing the browser doesn't stop publishing", async ({ page, browser, server }) => {
  await server.signIn(page);
  await connectedInstagram(page, server);
  await draftWithCaption(page, "Published while closed");
  const { date, time } = nowInNewYork();
  await scheduleAt(page, date, time);
  await page.close();
  await new Promise((r) => setTimeout(r, 4_000));

  const again = await browser.newPage();
  await server.signIn(again);
  await expect(again.locator(".post-card")).toContainText("simulated", { timeout: 10_000 });
});

test("an unconnected account's due post is kept and clearly not published", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "Planning IG" }]);
  await page.reload();
  await draftWithCaption(page, "Planned only");
  const { date, time } = nowInNewYork();
  await scheduleAt(page, date, time);
  await expect(page.locator(".schedule-panel .warnings")).toContainText("isn't connected");
  await expect(page.locator(".schedule-panel .state.attention")).toContainText("Not published: this account isn't connected", { timeout: 20_000 });

  await page.getByRole("button", { name: "← Back to posts" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "1 post needs your attention." })).toBeVisible();
  await page.locator(".post-card").click();
  await page.getByRole("button", { name: "Back to draft" }).click();
  await expect(page.locator(".schedule-panel")).toContainText("Schedule canceled. Not published.");
  await expect(page.getByLabel("Caption")).toBeEnabled();
});

test("an uncertain outcome asks the user instead of retrying", async ({ page, server }) => {
  await server.signIn(page);
  await connectedInstagram(page, server);
  await draftWithCaption(page, "Maybe posted [fake:unknown]");
  const { date, time } = nowInNewYork();
  await scheduleAt(page, date, time);
  const panel = page.locator(".schedule-panel");
  await expect(panel).toContainText("It's not certain whether this was published", { timeout: 20_000 });
  await expect(page.getByLabel("Caption")).toBeDisabled();
  await panel.getByRole("button", { name: "No, it wasn’t published" }).click();
  await expect(panel).toContainText("Not published");
  await expect(page.getByLabel("Caption")).toBeEnabled();
});

test("a lost response is reconciled, not republished", async ({ page, server }) => {
  await server.signIn(page);
  await connectedInstagram(page, server);
  await draftWithCaption(page, "Lost response [fake:lost]");
  const { date, time } = nowInNewYork();
  await scheduleAt(page, date, time);
  await expect(page.locator(".schedule-panel")).toContainText("Simulated publish", { timeout: 20_000 });
  await page.getByText("Publishing history").click();
  await expect(page.locator(".history li")).toHaveCount(1);
  await expect(page.locator(".history")).toContainText("Confirmed published after an uncertain response.");
});

test("a permanent rejection is shown with its reason", async ({ page, server }) => {
  await server.signIn(page);
  await connectedInstagram(page, server);
  await draftWithCaption(page, "Rejected [fake:permanent]");
  const { date, time } = nowInNewYork();
  await scheduleAt(page, date, time);
  await expect(page.locator(".schedule-panel .state.attention")).toContainText("Not published: Simulated permanent failure.", { timeout: 20_000 });
});

test("daylight-saving gaps and overlaps are resolved explicitly", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "IG" }]);
  await page.reload();
  await draftWithCaption(page, "DST");

  await scheduleAt(page, "2030-03-10", "02:30");
  const conflict = page.locator(".conflict");
  await expect(conflict).toContainText("doesn't exist in America/New_York");
  await conflict.getByRole("button", { name: "Use 2030-03-10 03:30 instead" }).click();
  await expect(page.locator(".schedule-panel .state")).toContainText("3:30");

  await scheduleAt(page, "2030-11-03", "01:30");
  await expect(conflict).toContainText("happens twice");
  await conflict.getByRole("button", { name: /^Second time/ }).click();
  await expect(page.locator(".schedule-panel .state")).toContainText(/1:30.*(EST|GMT-5)/);
});

test("canceling a future schedule returns the post to an editable state", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "instagram", displayName: "IG" }]);
  await page.reload();
  await draftWithCaption(page, "Later");
  await scheduleAt(page, "2030-01-15", "09:00");
  await expect(page.locator(".schedule-panel .state")).toContainText("Scheduled for");
  await page.getByRole("button", { name: "Cancel schedule" }).click();
  await expect(page.locator(".schedule-panel")).toContainText("Schedule canceled. Not published.");
});

test("shows scheduler health and saves settings", async ({ page, server }) => {
  await server.signIn(page);
  await createAccountsViaApi(page, [{ platform: "pinterest", displayName: "Pins" }]);
  await page.reload();
  await expect(page.locator(".service-line")).toContainText("Scheduler running", { timeout: 10_000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByLabel("Late publishing window (minutes)").fill("45");
  await dialog.getByLabel("Default time zone for new schedules").selectOption("Europe/London");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  await expect(tab(page, "Pins")).toBeVisible();
});
