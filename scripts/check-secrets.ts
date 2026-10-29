// Scans every git-tracked (and staged) file for credential-shaped strings.
// A substitute for GitHub secret scanning, which isn't available for this
// private repository. Runs in `npm run check`; exits non-zero on findings.
//
// Known documentation placeholders (AWS "EXAMPLE" keys) are allowed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "GitHub token", re: /\bgh[opsur]_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "AWS/R2-style access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Meta/Instagram access token", re: /\b(EAA[A-Za-z0-9]{40,}|IGAA[A-Za-z0-9_-]{40,}|IGQV[A-Za-z0-9_-]{40,})\b/ },
  { name: "Pinterest token", re: /\bpina_[A-Za-z0-9]{30,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Anthropic/OpenAI-style key", re: /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "Credential assignment", re: /\b(client_secret|app_secret|secret_access_key|access_token|refresh_token)\s*[:=]\s*["'][A-Za-z0-9/+_.-]{24,}["']/i },
];

const ALLOW = [/EXAMPLE/];

export interface Finding {
  file: string;
  line: number;
  kind: string;
}

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) findings.push({ file, line: i + 1, kind: p.name });
  });
  return findings;
}

export function trackedFiles(cwd = process.cwd()): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
  return out.split("\0").filter((f) => f && f !== "package-lock.json");
}

if (import.meta.main) {
  const findings = trackedFiles().flatMap((f) => {
    try {
      return scanText(f, readFileSync(f, "utf8"));
    } catch {
      return [];
    }
  });
  if (findings.length > 0) {
    // Report location and kind only; never echo the matched value.
    for (const f of findings) process.stderr.write(`${f.file}:${f.line}: possible ${f.kind}\n`);
    process.stderr.write(`\n${findings.length} possible secret(s) found. Remove them before committing.\n`);
    process.exit(1);
  }
  process.stdout.write("No secrets found in tracked or untracked (non-ignored) files.\n");
}
