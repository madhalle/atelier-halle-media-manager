// A complete scheduler environment on a temp database with a fake clock and
// deterministic fake platforms. Nothing leaves the process.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "../src/domain/accounts.ts";
import { createFakePlatform, type FakePlatform } from "../src/platforms/fake.ts";
import type { AdapterRegistry } from "../src/platforms/types.ts";
import { startScheduler, type Scheduler } from "../src/scheduler/scheduler.ts";
import type { WorkerDeps } from "../src/scheduler/worker.ts";
import { createAccountsRepo, type AccountsRepo } from "../src/storage/accounts-repo.ts";
import { prepareDataDir } from "../src/storage/data-dir.ts";
import { openDatabase, type Db } from "../src/storage/db.ts";
import { createMediaStore, type MediaStore } from "../src/storage/media-store.ts";
import { migrate } from "../src/storage/migrate.ts";
import { createPostsRepo, type PostsRepo } from "../src/storage/posts-repo.ts";
import { createScheduleRepo, type ScheduleRepo } from "../src/storage/schedule-repo.ts";
import { tempDir } from "./helpers.ts";
import { jpeg } from "./images.ts";

export class Clock {
  t: number;
  constructor(iso = "2026-10-29T12:00:00.000Z") {
    this.t = Date.parse(iso);
  }
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
  set(iso: string) {
    this.t = Date.parse(iso);
  }
}

export interface Env {
  dir: ReturnType<typeof tempDir>;
  db: Db;
  clock: Clock;
  accounts: AccountsRepo;
  posts: PostsRepo;
  media: MediaStore;
  schedule: ScheduleRepo;
  fakes: Record<Platform, FakePlatform>;
  adapters: AdapterRegistry;
  logs: { level: string; msg: string; obj: object }[];
  deps: WorkerDeps;
  scheduler: Scheduler;
  /** Reopen everything on the same data directory, as after a restart. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function createEnv(opts: { adapters?: "fake" | "none"; dir?: ReturnType<typeof tempDir> } = {}): Promise<Env> {
  const dir = opts.dir ?? tempDir("mm-sched-");
  const paths = prepareDataDir(dir.path);
  const clock = new Clock();
  const logs: Env["logs"] = [];
  const log = {
    info: (obj: object, msg: string) => logs.push({ level: "info", msg, obj }),
    warn: (obj: object, msg: string) => logs.push({ level: "warn", msg, obj }),
    error: (obj: object, msg: string) => logs.push({ level: "error", msg, obj }),
  };
  const fakes = { instagram: createFakePlatform("instagram"), pinterest: createFakePlatform("pinterest") };

  const env = {} as Env;
  const open = async () => {
    const db = openDatabase(paths.database);
    migrate(db);
    const accounts = createAccountsRepo(db, clock.now);
    const posts = createPostsRepo(db, accounts, clock.now);
    const media = createMediaStore(db, paths.media, clock.now);
    await media.init();
    const schedule = createScheduleRepo(db, posts);
    const adapters: AdapterRegistry = opts.adapters === "none" ? () => null : (p) => fakes[p];
    const deps: WorkerDeps = { accounts, posts, media, schedule, adapters, now: clock.now, random: () => 0.5, log };
    const scheduler = startScheduler({ ...deps, intervalMs: 60_000, autoStart: false });
    Object.assign(env, { db, accounts, posts, media, schedule, adapters, deps, scheduler });
  };
  await open();
  Object.assign(env, {
    dir,
    clock,
    fakes,
    logs,
    async restart() {
      await env.scheduler.stop();
      env.db.close();
      await open();
    },
    async close() {
      await env.scheduler.stop();
      env.db.close();
      dir.cleanup();
    },
  });
  return env;
}

let photoSeq = 0;
export async function photo(env: Env, width = 1080, height = 1080): Promise<string> {
  const tmp = join(env.dir.path, `upload-${photoSeq++}.jpg`);
  writeFileSync(tmp, await jpeg(width, height, { color: `#${(photoSeq * 2654435761 % 0xffffff).toString(16).padStart(6, "0")}` }));
  return (await env.media.ingest(tmp, "p.jpg")).asset.id;
}

export function connectedAccount(env: Env, platform: Platform = "instagram", name = "Business Instagram") {
  const a = env.accounts.create({ platform, displayName: name });
  env.accounts.markConnected(
    a.id,
    { providerAccountId: `pid-${a.id}`, username: "atelier", displayName: null, avatarUrl: null, accountType: "BUSINESS", verifiedAt: env.clock.now().toISOString() },
    `cred:kc-${a.id}`,
  );
  return env.accounts.acknowledgeScheduleReview(a.id);
}

/** A valid post scheduled `minutesAhead` from the fake clock. */
export async function scheduledPost(env: Env, accountId: string, minutesAhead = 10, caption = "New collection") {
  const account = env.accounts.get(accountId);
  let post = env.posts.createDraft(accountId, await photo(env));
  post = env.posts.update(post.id, post.revision, { fields: { caption, pinTitle: "Title", pinDescription: caption } });
  if (account.platform === "pinterest") {
    env.db.prepare("UPDATE posts SET pin_board_id = '123', pin_board_name = 'Collections' WHERE id = ?").run(post.id);
    post = env.posts.get(post.id);
  }
  const instant = new Date(env.clock.now().getTime() + minutesAhead * 60_000).toISOString();
  return env.schedule.schedule(post.id, post.revision, { instant, timezone: "America/New_York", localTime: "2026-10-29T08:10" }, env.clock.now());
}

export const commits = (env: Env, platform: Platform = "instagram") => env.fakes[platform].calls.filter((c) => c.step === "commit").length;
