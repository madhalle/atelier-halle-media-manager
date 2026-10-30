// The LaunchAgent definition and service log rotation.
import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { plist, rotateServiceLog } from "../src/server/launch-agent.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir("mm-agent-");
afterAll(() => dir.cleanup());

describe("LaunchAgent", () => {
  const spec = {
    label: "com.atelierhalle.media-manager",
    node: "/Users/x/.local/share/nodejs/node-v26/bin/node",
    main: "/Users/x/code/media manager/src/server/main.ts",
    cwd: "/Users/x/code/media manager",
    env: { MEDIA_MANAGER_ENV: "production", PATH: "/usr/bin:/bin" },
    log: "/Users/x/Library/Application Support/AtelierHalleMediaManager/logs/service.log",
  };

  it("is a valid property list that runs the server directly, with no shell", async () => {
    const file = join(dir.path, "agent.plist");
    writeFileSync(file, plist(spec));
    await promisify(execFile)("/usr/bin/plutil", ["-lint", file]);
    const json = JSON.parse((await promisify(execFile)("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout) as Record<string, unknown>;
    expect(json.ProgramArguments).toEqual([spec.node, spec.main]);
    expect(json.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(json.Umask).toBe(0o077);
    expect(json.EnvironmentVariables).toEqual(spec.env);
    expect(json.EnvironmentVariables).not.toHaveProperty("MEDIA_MANAGER_LIVE_PUBLISHING");
  });

  it("escapes values so a path can't inject plist keys", async () => {
    const file = join(dir.path, "evil.plist");
    writeFileSync(file, plist({ ...spec, cwd: "/tmp/</string><key>RunAtLoad</key><false/><string>" }));
    await promisify(execFile)("/usr/bin/plutil", ["-lint", file]);
    const json = JSON.parse((await promisify(execFile)("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout) as Record<string, unknown>;
    expect(json.WorkingDirectory).toBe("/tmp/</string><key>RunAtLoad</key><false/><string>");
    expect(json.RunAtLoad).toBe(true);
  });
});

describe("service log rotation", () => {
  it("keeps one previous copy and empties the live log beyond the limit", async () => {
    const log = join(dir.path, "service.log");
    writeFileSync(log, "x".repeat(100));
    expect(await rotateServiceLog(log, 200)).toBe(false);
    writeFileSync(log, "y".repeat(300));
    expect(await rotateServiceLog(log, 200)).toBe(true);
    expect(statSync(log).size).toBe(0);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("y".repeat(300));
  });
});
