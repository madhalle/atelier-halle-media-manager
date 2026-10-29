// Application-owned data directory layout, restricted to the current user.
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface DataPaths {
  root: string;
  database: string;
  media: string;
  backups: string;
  logs: string;
  launchFile: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    database: join(root, "media-manager.db"),
    media: join(root, "media"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
    launchFile: join(root, "launch.html"),
  };
}

/** Creates the layout with owner-only permissions and tightens existing dirs. */
export function prepareDataDir(root: string): DataPaths {
  const paths = dataPaths(root);
  for (const dir of [paths.root, paths.media, paths.backups, paths.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return paths;
}

/**
 * Resolves `untrusted` beneath `base`, rejecting anything that would escape
 * it (`..`, absolute paths, NUL bytes). Use for every path built from input.
 */
export function containedPath(base: string, untrusted: string): string {
  if (untrusted.includes("\0")) throw new Error("Invalid path");
  const root = resolve(base);
  const target = resolve(root, untrusted);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Path escapes its base directory");
  }
  return target;
}
