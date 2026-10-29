// Runtime configuration, validated once at startup from the environment.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const APP_DIR_NAME = "AtelierHalleMediaManager";

export type AppEnv = "production" | "development" | "test";

export interface Config {
  env: AppEnv;
  host: "127.0.0.1";
  port: number;
  dataDir: string;
  /** Absolute path to the built web UI (Vite output). */
  webRoot: string;
  /** Live platform calls are only possible in production with this enabled. */
  livePublishing: boolean;
  /** Simulated platforms for development and tests. Never allowed in production. */
  fakePlatforms: boolean;
  schedulerIntervalMs: number;
  /** How far ahead a schedule must be. Shorter leads are allowed only outside production. */
  minScheduleLeadMs: number;
  /** Loopback fake platform origins for browser tests. Only ever set in the test environment. */
  testEndpoints: TestEndpoints | null;
}

export interface TestEndpoints {
  instagramAuthorize: string;
  instagramApi: string;
  instagramGraph: string;
  pinterestAuthorize: string;
  pinterestApi: string;
  pinterestSandboxApi: string;
  r2: string;
}

const loopbackUrl = z.string().refine((v) => /^http:\/\/127\.0\.0\.1:\d+$/.test(v), "must be a loopback origin");
const TestEndpointsSchema = z
  .object({
    instagramAuthorize: z.string().url(),
    instagramApi: loopbackUrl,
    instagramGraph: loopbackUrl,
    pinterestAuthorize: z.string().url(),
    pinterestApi: loopbackUrl,
    pinterestSandboxApi: loopbackUrl,
    r2: loopbackUrl,
  })
  .strict();

const EnvSchema = z.object({
  MEDIA_MANAGER_ENV: z.enum(["production", "development", "test"]).default("production"),
  MEDIA_MANAGER_PORT: z.coerce.number().int().min(1024).max(65535).optional(),
  MEDIA_MANAGER_DATA_DIR: z.string().min(1).optional(),
  MEDIA_MANAGER_LIVE_PUBLISHING: z.enum(["enabled", "disabled"]).default("disabled"),
  MEDIA_MANAGER_FAKE_PLATFORMS: z.enum(["enabled", "disabled"]).default("disabled"),
  MEDIA_MANAGER_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).max(15 * 60_000).default(60_000),
  // Negative values (non-production only) allow scheduling slightly in the past, for fast browser tests.
  MEDIA_MANAGER_MIN_LEAD_SECONDS: z.coerce.number().int().min(-600).max(3600).default(60),
  MEDIA_MANAGER_TEST_ENDPOINTS: z.string().optional(),
});

export function productionDataDir(home = homedir()): string {
  return join(home, "Library", "Application Support", APP_DIR_NAME);
}

const DEFAULT_PORTS: Record<AppEnv, number> = { production: 4870, development: 4871, test: 4872 };

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = resolve(import.meta.dirname, "..", ".."),
): Config {
  const parsed = EnvSchema.parse(env);
  const appEnv = parsed.MEDIA_MANAGER_ENV;

  let dataDir: string;
  if (parsed.MEDIA_MANAGER_DATA_DIR) {
    if (!isAbsolute(parsed.MEDIA_MANAGER_DATA_DIR)) {
      throw new Error("MEDIA_MANAGER_DATA_DIR must be an absolute path");
    }
    dataDir = resolve(parsed.MEDIA_MANAGER_DATA_DIR);
  } else if (appEnv === "production") {
    dataDir = productionDataDir();
  } else if (appEnv === "development") {
    dataDir = join(repoRoot, ".data", "development");
  } else {
    throw new Error("Tests must set MEDIA_MANAGER_DATA_DIR to an isolated temporary directory");
  }

  // Development and test data must never mix with real data.
  if (appEnv !== "production" && dataDir === productionDataDir()) {
    throw new Error(`Refusing to use the production data directory in ${appEnv}`);
  }

  const livePublishing = parsed.MEDIA_MANAGER_LIVE_PUBLISHING === "enabled";
  if (livePublishing && appEnv !== "production") {
    throw new Error("Live publishing can only be enabled in production");
  }

  const fakePlatforms = parsed.MEDIA_MANAGER_FAKE_PLATFORMS === "enabled";
  if (fakePlatforms && appEnv === "production") {
    throw new Error("Simulated platforms can never be enabled in production");
  }
  if (fakePlatforms && livePublishing) throw new Error("Simulated and live publishing are mutually exclusive");
  if (appEnv === "production" && parsed.MEDIA_MANAGER_MIN_LEAD_SECONDS < 60) {
    throw new Error("In production, schedules must be at least 60 seconds ahead");
  }

  let testEndpoints: TestEndpoints | null = null;
  if (parsed.MEDIA_MANAGER_TEST_ENDPOINTS !== undefined) {
    if (appEnv !== "test") throw new Error("Test endpoints can only be used in the test environment");
    testEndpoints = TestEndpointsSchema.parse(JSON.parse(parsed.MEDIA_MANAGER_TEST_ENDPOINTS));
  }

  return {
    env: appEnv,
    host: "127.0.0.1",
    port: parsed.MEDIA_MANAGER_PORT ?? DEFAULT_PORTS[appEnv],
    dataDir,
    webRoot: join(repoRoot, "dist", "web"),
    livePublishing,
    fakePlatforms,
    schedulerIntervalMs: parsed.MEDIA_MANAGER_SCHEDULER_INTERVAL_MS,
    minScheduleLeadMs: parsed.MEDIA_MANAGER_MIN_LEAD_SECONDS * 1000,
    testEndpoints,
  };
}
