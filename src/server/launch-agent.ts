// The per-user LaunchAgent definition (installed by scripts/service.ts) and
// rotation of the log file launchd writes the server's output to.
import { existsSync } from "node:fs";
import { copyFile, stat, truncate } from "node:fs/promises";

export const SERVICE_LOG = "service.log";
/** The service log is rotated (one previous copy kept) beyond this size. */
export const MAX_SERVICE_LOG_BYTES = 10 * 1024 * 1024;

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const str = (s: string) => `<string>${xml(s)}</string>`;

export interface AgentSpec {
  label: string;
  node: string;
  main: string;
  cwd: string;
  env: Record<string, string>;
  log: string;
}

export function plist(o: AgentSpec): string {
  const env = Object.entries(o.env)
    .map(([k, v]) => `      <key>${xml(k)}</key>${str(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>${str(o.label)}
    <key>ProgramArguments</key>
    <array>${str(o.node)}${str(o.main)}</array>
    <key>WorkingDirectory</key>${str(o.cwd)}
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <!-- Restart after a crash, but not after a clean stop. -->
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>Umask</key><integer>63</integer>
    <key>StandardOutPath</key>${str(o.log)}
    <key>StandardErrorPath</key>${str(o.log)}
  </dict>
</plist>
`;
}

/**
 * launchd keeps the log open in append mode, so copying it aside and
 * truncating in place is safe: later writes start again at the beginning.
 */
export async function rotateServiceLog(file: string, maxBytes = MAX_SERVICE_LOG_BYTES): Promise<boolean> {
  if (!existsSync(file) || (await stat(file)).size <= maxBytes) return false;
  await copyFile(file, `${file}.1`);
  await truncate(file, 0);
  return true;
}
