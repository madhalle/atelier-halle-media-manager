// Prevents two server processes from using the same data directory.
import { readFileSync, rmSync, writeFileSync } from "node:fs";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Acquires the lock or throws. Returns a release function. */
export function acquireInstanceLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => {
        if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
        throw new Error(`Another Media Manager process (pid ${pid}) is already using this data directory`);
      }
      rmSync(file, { force: true }); // stale lock from a crashed process
    }
  }
  throw new Error("Could not acquire the instance lock");
}
