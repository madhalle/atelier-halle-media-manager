// Runs Media Manager in the background as a per-user LaunchAgent, so it
// starts at login and scheduled posts go out without a Terminal window.
//
//   npm run service -- install [--live]   install and start (--live enables real publishing)
//   npm run service -- status             is it running, healthy, and can it use the Keychain?
//   npm run service -- stop | start       stop until next login / start again
//   npm run service -- uninstall          stop and remove
//
// A LaunchAgent runs in your login session, so the login Keychain is
// available; the server checks it at startup and `status` reports the result.
// The agent pins the current Node binary: after upgrading Node, run install again.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { loadConfig } from "../src/server/config.ts";
import { plist, SERVICE_LOG } from "../src/server/launch-agent.ts";
import { dataPaths, prepareDataDir } from "../src/storage/data-dir.ts";

const run = promisify(execFile);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { env: { type: "string", default: "production" }, live: { type: "boolean", default: false } },
});
if (values.env !== "production" && values.env !== "development") {
  process.stderr.write("--env must be production or development.\n");
  process.exit(1);
}
const config = loadConfig({ ...process.env, MEDIA_MANAGER_ENV: values.env });
const label = values.env === "production" ? "com.atelierhalle.media-manager" : "com.atelierhalle.media-manager.dev";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid!()}`;
const repo = resolve(import.meta.dirname, "..");
const paths = dataPaths(config.dataDir);
const logFile = join(paths.logs, SERVICE_LOG);
const out = (s: string) => process.stdout.write(`${s}\n`);

async function launchctl(...args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const r = await run("/bin/launchctl", args);
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const loaded = async () => (await launchctl("print", `${domain}/${label}`)).ok;

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The most recent Keychain result the server logged. */
function keychainLine(): string {
  if (!existsSync(logFile)) return "unknown (no service log yet)";
  const lines = readFileSync(logFile, "utf8").trim().split("\n").reverse();
  for (const line of lines) {
    if (line.includes("keychain check passed")) return "OK";
    if (line.includes("Keychain unavailable")) return "NOT available. Open the app's Platform setup for details";
  }
  return "unknown (not checked yet)";
}

async function install(): Promise<void> {
  if (!existsSync(join(repo, "dist", "web", "index.html"))) throw new Error("Build the interface first: npm run build");
  if (await loaded()) await launchctl("bootout", `${domain}/${label}`);
  if (await healthy()) throw new Error(`Media Manager is already running on port ${config.port}. Stop it (Ctrl+C) first.`);
  prepareDataDir(config.dataDir);
  const env: Record<string, string> = { MEDIA_MANAGER_ENV: values.env!, PATH: "/usr/bin:/bin" };
  if (process.env.MEDIA_MANAGER_DATA_DIR) env.MEDIA_MANAGER_DATA_DIR = config.dataDir;
  if (process.env.MEDIA_MANAGER_PORT) env.MEDIA_MANAGER_PORT = String(config.port);
  if (values.live) env.MEDIA_MANAGER_LIVE_PUBLISHING = "enabled";
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist({ label, node: process.execPath, main: join(repo, "src", "server", "main.ts"), cwd: repo, env, log: logFile }), { mode: 0o644 });
  await run("/usr/bin/plutil", ["-lint", plistPath]);
  const r = await launchctl("bootstrap", domain, plistPath);
  if (!r.ok) throw new Error(`launchctl refused the agent: ${r.stderr.trim()}`);
  for (let i = 0; i < 30 && !(await healthy()); i++) await new Promise((res) => setTimeout(res, 500));
  out((await healthy()) ? `Installed and running on http://127.0.0.1:${config.port}. Live publishing: ${values.live ? "ON" : "off"}.` : `Installed, but it isn't answering yet. See ${logFile}`);
  out("Open it with: npm run open" + (values.env === "production" ? "" : ` -- --env ${values.env}`));
}

async function status(): Promise<void> {
  out(`Installed:  ${existsSync(plistPath) ? "yes" : "no"}`);
  const p = await launchctl("print", `${domain}/${label}`);
  const pid = /\bpid = (\d+)/.exec(p.stdout)?.[1];
  out(`Loaded:     ${p.ok ? `yes${pid ? ` (pid ${pid})` : ", not running"}` : "no"}`);
  out(`Responding: ${(await healthy()) ? "yes" : "no"}`);
  out(`Keychain:   ${keychainLine()}`);
  if (existsSync(plistPath)) out(`Live publishing: ${readFileSync(plistPath, "utf8").includes("MEDIA_MANAGER_LIVE_PUBLISHING") ? "ON" : "off"}`);
  out(`Log:        ${logFile}`);
}

async function main(): Promise<void> {
  const [command] = positionals;
  switch (command) {
    case "install":
      return install();
    case "status":
      return status();
    case "stop": {
      // SIGTERM → clean shutdown → exit 0, which KeepAlive leaves stopped until next login.
      const r = await launchctl("kill", "SIGTERM", `${domain}/${label}`);
      out(r.ok ? "Stopped. It starts again at next login, or with: npm run service -- start" : "It isn't running.");
      return;
    }
    case "start": {
      const r = await launchctl("kickstart", `${domain}/${label}`);
      if (!r.ok) throw new Error("It isn't installed. Use: npm run service -- install");
      out("Started.");
      return;
    }
    case "uninstall": {
      await launchctl("bootout", `${domain}/${label}`);
      rmSync(plistPath, { force: true });
      out("Removed. Your data is untouched.");
      return;
    }
    default:
      throw new Error("Use install, status, stop, start or uninstall.");
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
