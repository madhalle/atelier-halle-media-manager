import { defineConfig, devices } from "@playwright/test";

// Browser tests run the real server against throwaway data directories.
// Live publishing is never enabled here (the server refuses it outside production).
// `npm run qa` sets QA_RECORDING to keep a video, screenshots and a trace of every
// test for review; normal runs skip them to stay fast.
const recording = process.env.QA_RECORDING === "enabled";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: recording ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: recording
    ? { trace: "on", video: "on", screenshot: "on" }
    : { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
