// Scheduling API: schedule/reschedule, cancel, resolve outcomes, history,
// settings and scheduler health.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError } from "../../domain/errors.ts";
import { validatePost } from "../../domain/posts.ts";
import { resolveLocalTime } from "../../domain/time.ts";
import type { AccountsRepo } from "../../storage/accounts-repo.ts";
import type { MediaStore } from "../../storage/media-store.ts";
import type { PostsRepo } from "../../storage/posts-repo.ts";
import type { ScheduleRepo } from "../../storage/schedule-repo.ts";
import type { PostView } from "./posts.ts";

const IdParams = z.object({ id: z.uuid() });
const ScheduleBody = z
  .object({
    revision: z.number().int().positive(),
    localTime: z.string().max(20),
    timeZone: z.string().max(64),
    choice: z.enum(["earlier", "later"]).optional(),
  })
  .strict();
const RevisionBody = z.object({ revision: z.number().int().positive() }).strict();
const ResolveBody = z.object({ revision: z.number().int().positive(), outcome: z.enum(["published", "not_published"]) }).strict();
const SettingsBody = z
  .object({ defaultTimezone: z.string().max(64), missedGraceMinutes: z.number().int() })
  .partial()
  .strict();

export interface ScheduleRouteDeps {
  accounts: AccountsRepo;
  posts: PostsRepo;
  media: MediaStore;
  schedule: ScheduleRepo;
  view: (id: string) => PostView;
  now: () => Date;
  minLeadMs: number;
  simulated: boolean;
  livePublishing: boolean;
}

export function registerScheduleRoutes(api: FastifyInstance, d: ScheduleRouteDeps): void {
  api.post("/posts/:id/schedule", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = ScheduleBody.parse(req.body);
    const post = d.posts.get(id);
    const account = d.accounts.get(post.accountId);
    if (account.archivedAt !== null) throw new DomainError("invalid_state", "Restore this account before scheduling.");

    const resolved = resolveLocalTime(body.localTime, body.timeZone, body.choice);
    if (resolved.kind === "nonexistent") {
      return reply.code(409).send({
        error: "nonexistent_time",
        message: `${body.localTime.replace("T", " ")} doesn't exist in ${body.timeZone}: clocks skip that hour for daylight saving time.`,
        suggestion: resolved.suggestion,
      });
    }
    if (resolved.kind === "ambiguous") {
      return reply.code(409).send({
        error: "ambiguous_time",
        message: `${body.localTime.replace("T", " ")} happens twice in ${body.timeZone} because clocks fall back. Choose which one.`,
        earlier: resolved.earlier,
        later: resolved.later,
      });
    }
    if (Date.parse(resolved.instant) < d.now().getTime() + d.minLeadMs) {
      throw new DomainError("validation", d.minLeadMs >= 60_000 ? "Choose a time at least a minute from now." : "That time has already passed.");
    }

    const assets = new Map(post.media.map((m) => [m.mediaAssetId, d.media.get(m.mediaAssetId)]));
    const connected = account.connectionState === "connected";
    const blocking = validatePost(account.platform, post, assets).filter(
      // Boards can only be chosen once connected; unconnected accounts may still plan.
      (i) => i.severity === "blocking" && !(i.field === "pinBoard" && !connected),
    );
    if (blocking.length > 0) {
      return reply.code(400).send({ error: "validation", message: `Fix this before scheduling: ${blocking[0]!.message}`, issues: blocking });
    }

    d.schedule.schedule(id, body.revision, { instant: resolved.instant, timezone: body.timeZone, localTime: body.localTime }, d.now());
    const warnings: string[] = [];
    if (!connected) {
      warnings.push("This account isn't connected. Unless you connect it first, the post will be marked as not published when it's due.");
    }
    if (account.schedulesNeedReview) warnings.push("This account's schedules are paused until you mark them reviewed.");
    return { post: d.view(id), warnings };
  });

  api.post("/posts/:id/cancel", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision } = RevisionBody.parse(req.body);
    const { immediate } = d.schedule.cancel(id, revision, d.now());
    return {
      post: d.view(id),
      immediate,
      message: immediate
        ? "Schedule canceled. The post is back to an editable draft."
        : "This post is already being sent. The app will stop it if it hasn't reached the platform yet; otherwise it will check what happened and show the result.",
    };
  });

  api.post("/posts/:id/dismiss", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision } = RevisionBody.parse(req.body);
    d.schedule.dismissAttention(id, revision, d.now());
    return { post: d.view(id) };
  });

  api.post("/posts/:id/resolve", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision, outcome } = ResolveBody.parse(req.body);
    d.schedule.resolveAmbiguous(id, revision, outcome, d.now());
    return { post: d.view(id) };
  });

  api.get("/posts/:id/attempts", async (req) => {
    const { id } = IdParams.parse(req.params);
    d.posts.get(id);
    return { attempts: d.schedule.attempts(id) };
  });

  api.get("/settings", async () => ({ settings: d.schedule.settings() }));

  api.patch("/settings", async (req) => {
    const body = SettingsBody.parse(req.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return { settings: d.schedule.updateSettings(patch, d.now()) };
  });

  api.get("/health", async () => {
    const status = d.schedule.status();
    const now = d.now();
    const intervalMs = status?.intervalMs ?? 60_000;
    const last = status?.lastTickAt ? Date.parse(status.lastTickAt) : null;
    return {
      scheduler: {
        running: status !== null,
        lastCheckAt: status?.lastTickAt ?? null,
        intervalSeconds: Math.round(intervalMs / 1000),
        stale: last === null || now.getTime() - last > intervalMs * 3,
        lastError: status?.lastTickError ?? null,
      },
      counts: d.schedule.counts(now, intervalMs * 2),
      settings: d.schedule.settings(),
      publishing: d.simulated ? "simulated" : d.livePublishing ? "live" : "not_configured",
    };
  });
}
