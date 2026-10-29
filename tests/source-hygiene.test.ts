// Guards against "Trojan Source" style invisible bidirectional controls in code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src", "tests", "scripts", "migrations"];
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("source hygiene", () => {
  it("contains no bidirectional control characters", () => {
    const offenders = ROOTS.flatMap(files).filter((f) => BIDI.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
