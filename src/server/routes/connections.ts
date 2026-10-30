// Platform setup (developer apps, R2), connecting/disconnecting accounts,
// the OAuth callback page, and Pinterest boards.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PLATFORMS } from "../../domain/accounts.ts";
import { DomainError } from "../../domain/errors.ts";
import { PlatformError } from "../../domain/publishing.ts";
import type { R2Stager } from "../../delivery/r2.ts";
import type { ConnectionService } from "../../platforms/connect.ts";
import type { PinterestAdapter } from "../../platforms/pinterest.ts";
import type { AccountsRepo } from "../../storage/accounts-repo.ts";
import type { PlatformConfig } from "../../storage/platform-config.ts";
import type { PostsRepo } from "../../storage/posts-repo.ts";
import { SESSION_COOKIE } from "../app.ts";
import { toAccountView } from "./accounts.ts";

const IdParams = z.object({ id: z.uuid() });
const PlatformParams = z.object({ platform: z.enum(PLATFORMS) });
const KindParams = z.object({ kind: z.enum(["instagram", "pinterest", "r2"]) });
const CompleteBody = z
  .object({ state: z.string().min(16).max(200), code: z.string().min(1).max(2048).optional(), error: z.string().max(200).optional() })
  .strict();
const BoardBody = z.object({ revision: z.number().int().positive(), boardId: z.string().regex(/^\d{1,30}$/) }).strict();

export interface ConnectionRouteDeps {
  accounts: AccountsRepo;
  posts: PostsRepo;
  config: PlatformConfig;
  connections: ConnectionService;
  pinterest: PinterestAdapter;
  r2: R2Stager;
  keychainStatus: () => { ok: boolean; reason: string | null; kind: "keychain" | "memory" };
  livePublishing: boolean;
  view: (postId: string) => unknown;
}

export function registerConnectionRoutes(api: FastifyInstance, d: ConnectionRouteDeps): void {
  const sessionId = (req: { cookies: Record<string, string | undefined> }) => {
    const s = req.cookies[SESSION_COOKIE];
    if (!s) throw new DomainError("validation", "No session.");
    return s;
  };

  api.get("/platforms", async () => ({
    config: d.config.view(),
    redirectUris: { instagram: d.connections.redirectUri("instagram"), pinterest: d.connections.redirectUri("pinterest") },
    keychain: d.keychainStatus(),
    livePublishing: d.livePublishing,
  }));

  // Secrets are accepted here and go straight to the Keychain; responses only report "saved".
  api.patch("/platforms", async (req) => ({ config: await d.config.update(req.body) }));

  api.delete("/platforms/:kind", async (req) => {
    const { kind } = KindParams.parse(req.params);
    return { config: await d.config.clear(kind) };
  });

  // Upload, read back and delete a tiny object. Never touches Instagram.
  api.post("/platforms/r2/test", async () => {
    try {
      await d.r2.selfTest();
    } catch (err) {
      if (err instanceof PlatformError) throw new DomainError("invalid_state", err.safeMessage);
      throw err;
    }
    return { ok: true };
  });

  api.post("/accounts/:id/connect", async (req) => {
    const { id } = IdParams.parse(req.params);
    return d.connections.start(id, sessionId(req));
  });

  api.post("/oauth/:platform/complete", async (req) => {
    const { platform } = PlatformParams.parse(req.params);
    const body = CompleteBody.parse(req.body);
    const account = await d.connections.complete(platform, body, sessionId(req));
    return { account: toAccountView(account) };
  });

  api.post("/accounts/:id/disconnect", async (req) => {
    const { id } = IdParams.parse(req.params);
    const r = await d.connections.disconnect(id);
    return { account: toAccountView(r.account), credentialRemoved: r.credentialRemoved, followUp: r.followUp };
  });

  api.get("/accounts/:id/boards", async (req) => {
    const { id } = IdParams.parse(req.params);
    const account = d.accounts.get(id);
    if (account.platform !== "pinterest") throw new DomainError("validation", "Boards are a Pinterest feature.");
    if (account.connectionState !== "connected") throw new DomainError("invalid_state", "Connect this account to load its boards.");
    try {
      return { boards: await d.pinterest.listBoards(account) };
    } catch (err) {
      if (err instanceof PlatformError) throw new DomainError("invalid_state", err.safeMessage);
      throw err;
    }
  });

  api.post("/posts/:id/board", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision, boardId } = BoardBody.parse(req.body);
    const post = d.posts.get(id);
    const account = d.accounts.get(post.accountId);
    if (account.platform !== "pinterest" || account.connectionState !== "connected") {
      throw new DomainError("invalid_state", "Connect this Pinterest account to choose a board.");
    }
    let boards;
    try {
      boards = await d.pinterest.listBoards(account);
    } catch (err) {
      if (err instanceof PlatformError) throw new DomainError("invalid_state", err.safeMessage);
      throw err;
    }
    const board = boards.find((b) => b.id === boardId);
    if (!board) throw new DomainError("validation", "That board isn't on this Pinterest account.");
    d.posts.setBoard(id, revision, board.id, board.name);
    return { post: d.view(id) };
  });
}

/** The OAuth redirect target. No secrets or state are rendered into the page. */
export function registerOAuthCallbackPage(app: FastifyInstance): void {
  app.get("/oauth/:platform/callback", async (req, reply) => {
    PlatformParams.parse(req.params);
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connecting… · Media Manager</title>
<link rel="stylesheet" href="/oauth/callback.css">
<main>
  <h1>Media Manager</h1>
  <p id="msg" role="status">Finishing sign-in…</p>
  <p><a href="/">Back to the app</a></p>
</main>
<script src="/oauth/callback.js"></script>
</html>`);
  });

  app.get("/oauth/callback.css", async (_req, reply) =>
    reply
      .type("text/css; charset=utf-8")
      .header("cache-control", "no-store")
      .send("main{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}h1{font-size:1.3rem}"),
  );

  app.get("/oauth/callback.js", async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").header("cache-control", "no-store").send(CALLBACK_JS),
  );
}

// Moves to the canonical 127.0.0.1 origin (where the session cookie lives),
// strips the code from the address bar, then completes with session + CSRF.
const CALLBACK_JS = `"use strict";
(function () {
  var msg = document.getElementById("msg");
  var platform = location.pathname.split("/")[2];
  if (location.hostname !== "127.0.0.1") {
    location.replace("http://127.0.0.1:" + location.port + location.pathname + location.search);
    return;
  }
  var q = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  var body = { state: q.get("state") || "" };
  if (q.get("code")) body.code = q.get("code");
  if (q.get("error")) body.error = q.get("error");
  fetch("/api/session", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) throw new Error("This browser isn't signed in to Media Manager. Run \\"npm run open\\", then connect again.");
      return r.json();
    })
    .then(function (s) {
      return fetch("/api/oauth/" + encodeURIComponent(platform) + "/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": s.csrfToken },
        body: JSON.stringify(body)
      });
    })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.message || "Connecting failed.");
        location.replace("/#/accounts/" + data.account.id);
      });
    })
    .catch(function (err) {
      msg.textContent = err && err.message ? err.message : "Connecting failed.";
    });
})();
`;
