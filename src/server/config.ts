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
}

const EnvSchema = z.object({
  MEDIA_MANAGER_ENV: z.enum(["production", "development", "test"]).default("production"),
  MEDIA_MANAGER_PORT: z.coerce.number().int().min(1024).max(65535).optional(),
  MEDIA_MANAGER_DATA_DIR: z.string().min(1).optional(),
  MEDIA_MANAGER_LIVE_PUBLISHING: z.enum(["enabled", "disabled"]).default("disabled"),
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

  return {
    env: appEnv,
    host: "127.0.0.1",
    port: parsed.MEDIA_MANAGER_PORT ?? DEFAULT_PORTS[appEnv],
    dataDir,
    webRoot: join(repoRoot, "dist", "web"),
    livePublishing,
  };
}
