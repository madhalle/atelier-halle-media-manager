import { defineConfig, devices } from "@playwright/test";

// Browser tests run the real server against throwaway data directories.
// Live publishing is never enabled here (the server refuses it outside production).
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
