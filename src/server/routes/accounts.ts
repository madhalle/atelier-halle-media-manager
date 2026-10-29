// Account management API. Connecting real platforms arrives with OAuth; until
// then accounts are created unconnected and can never publish.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canPublish, PLATFORMS, type Account } from "../../domain/accounts.ts";
import type { AccountsRepo } from "../../storage/accounts-repo.ts";

export interface AccountView {
  id: string;
  platform: Account["platform"];
  displayName: string;
  sortOrder: number;
  archived: boolean;
  archivedAt: string | null;
  connection: {
    state: Account["connectionState"];
    identity: {
      username: string | null;
      displayName: string | null;
      accountType: string | null;
      verifiedAt: string;
    } | null;
  };
  schedulesNeedReview: boolean;
  publishing: { ready: boolean; blockers: string[] };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export function publishingBlockers(a: Account): string[] {
  const blockers: string[] = [];
  if (a.archivedAt !== null) blockers.push("Archived accounts never publish.");
  if (a.connectionState === "unconnected") blockers.push("Not connected to a platform account yet.");
  if (a.connectionState === "disconnected") blockers.push("Disconnected. Reconnect to publish.");
  if (a.connectionState === "needs_reconnect") blockers.push("The platform connection expired. Reconnect to publish.");
  if (a.schedulesNeedReview) blockers.push("Pending schedules are paused until you review them.");
  return blockers;
}

// Credential references and raw provider IDs stay server-side.
export function toAccountView(a: Account): AccountView {
  return {
    id: a.id,
    platform: a.platform,
    displayName: a.displayName,
    sortOrder: a.sortOrder,
    archived: a.archivedAt !== null,
    archivedAt: a.archivedAt,
    connection: {
      state: a.connectionState,
      identity: a.identity && {
        username: a.identity.username,
        displayName: a.identity.displayName,
        accountType: a.identity.accountType,
        verifiedAt: a.identity.verifiedAt,
      },
    },
    schedulesNeedReview: a.schedulesNeedReview,
    publishing: { ready: canPublish(a), blockers: publishingBlockers(a) },
    revision: a.revision,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

const IdParams = z.object({ id: z.uuid() });
const ListQuery = z.object({ includeArchived: z.enum(["true", "false"]).default("false") });
const CreateBody = z.object({ platform: z.enum(PLATFORMS), displayName: z.string().max(500) }).strict();
const RenameBody = z.object({ displayName: z.string().max(500), revision: z.number().int().positive() }).strict();
const RevisionBody = z.object({ revision: z.number().int().positive() }).strict();
const ReorderBody = z.object({ ids: z.array(z.uuid()).max(500) }).strict();

export function registerAccountRoutes(api: FastifyInstance, accounts: AccountsRepo): void {
  api.get("/accounts", async (req) => {
    const { includeArchived } = ListQuery.parse(req.query);
    return { accounts: accounts.list({ includeArchived: includeArchived === "true" }).map(toAccountView) };
  });

  api.post("/accounts", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    return reply.code(201).send({ account: toAccountView(accounts.create(body)) });
  });

  api.get("/accounts/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    return { account: toAccountView(accounts.get(id)) };
  });

  api.patch("/accounts/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = RenameBody.parse(req.body);
    return { account: toAccountView(accounts.rename(id, body.displayName, body.revision)) };
  });

  api.post("/accounts/reorder", async (req) => {
    const { ids } = ReorderBody.parse(req.body);
    return { accounts: accounts.reorder(ids).map(toAccountView) };
  });

  api.post("/accounts/:id/archive", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision } = RevisionBody.parse(req.body);
    return { account: toAccountView(accounts.archive(id, revision)) };
  });

  api.post("/accounts/:id/restore", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision } = RevisionBody.parse(req.body);
    return { account: toAccountView(accounts.restore(id, revision)) };
  });

  api.post("/accounts/:id/acknowledge-review", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision } = RevisionBody.parse(req.body);
    return { account: toAccountView(accounts.acknowledgeScheduleReview(id, revision)) };
  });
}
