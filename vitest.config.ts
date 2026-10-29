import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Live publishing must never run in tests; adapters check this flag.
    env: { MEDIA_MANAGER_LIVE_PUBLISHING: "disabled" },
  },
});
