import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanText, trackedFiles } from "../scripts/check-secrets.ts";

describe("secret scanner", () => {
  it("detects credential-shaped strings and allows AWS documentation placeholders", () => {
    const fake = (prefix: string, n: number) => prefix + "a1B2c3D4".repeat(Math.ceil(n / 8)).slice(0, n);
    const samples = [
      fake("ghp_", 36),
      fake("gho_", 36),
      "AKIA" + "QWERTYUIOPASDFGH",
      ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "),
      fake("IGAA", 60),
      fake("pina_", 40),
    ];
    for (const s of samples) expect(scanText("x.ts", `const v = ${JSON.stringify(s)};`)).toHaveLength(1);
    expect(scanText("config.ts", `client_secret = "${fake("", 32)}"`)).toHaveLength(1);
    expect(scanText("x.ts", 'const k = "AKIAIOSFODNN7EXAMPLE";')).toEqual([]);
    expect(scanText("x.ts", "const ok = 'hello world';")).toEqual([]);
  });

  it("finds no secrets anywhere in the repository", () => {
    const findings = trackedFiles().flatMap((f) => {
      try {
        return scanText(f, readFileSync(f, "utf8"));
      } catch {
        return [];
      }
    });
    expect(findings).toEqual([]);
  });
});
