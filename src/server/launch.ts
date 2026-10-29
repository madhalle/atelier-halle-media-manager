// Publishes the current launch link to an owner-only file in the data
// directory. `npm run open` opens that file in the browser, so the token never
// appears in process arguments.
import { renameSync, rmSync, writeFileSync } from "node:fs";

export function launchUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/launch?token=${encodeURIComponent(token)}`;
}

export function writeLaunchFile(file: string, url: string): void {
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${url}">
<title>Opening Media Manager…</title>
<p>Opening Media Manager…</p>
`;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, html, { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeLaunchFile(file: string): void {
  rmSync(file, { force: true });
}
