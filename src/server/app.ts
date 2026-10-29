// Fastify application: one loopback origin serving the API and the built UI.
import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, type DomainErrorCode } from "../domain/errors.ts";
import { createPlatformServices, type PlatformServices } from "../platforms/services.ts";
import type { Endpoints } from "../platforms/http.ts";
import { createAccountsRepo } from "../storage/accounts-repo.ts";
import { CredentialUnavailable, type CredentialStore } from "../storage/credentials.ts";
import { dataPaths } from "../storage/data-dir.ts";
import { createMediaStore } from "../storage/media-store.ts";
import { createPostsRepo } from "../storage/posts-repo.ts";
import { createScheduleRepo } from "../storage/schedule-repo.ts";
import type { Db } from "../storage/db.ts";
import type { Config } from "./config.ts";
import { registerAccountRoutes } from "./routes/accounts.ts";
import { registerConnectionRoutes, registerOAuthCallbackPage } from "./routes/connections.ts";
import { registerMediaRoutes } from "./routes/media.ts";
import { registerPostRoutes } from "./routes/posts.ts";
import { registerScheduleRoutes } from "./routes/schedule.ts";
import { allowedHosts, allowedOrigins, checkSameOrigin, isUnsafeMethod, redactUrl, SECURITY_HEADERS } from "./security.ts";
import { safeEqual, SESSION_ABSOLUTE_TTL_MS, type Session, type SessionStore } from "./sessions.ts";

export const SESSION_COOKIE = "mm_session";
export const CSRF_HEADER = "x-csrf-token";

export interface AppDeps {
  config: Config;
  db: Db;
  sessions: SessionStore;
  version: string;
  /** Called after a launch token is consumed, so a fresh one can be published. */
  onLaunchTokenUsed?: () => void;
  logStream?: { write(line: string): void };
  now?: () => Date;
  /** Keychain in production/development; an in-memory store in tests. */
  credentials: CredentialStore;
  /** Shared with the scheduler when provided. */
  services?: PlatformServices;
  endpoints?: Endpoints;
  fetchImpl?: typeof fetch;
  keychainStatus?: () => { ok: boolean; reason: string | null; kind: "keychain" | "memory" };
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  validation: 400,
  not_found: 404,
  stale_revision: 409,
  invalid_state: 409,
  duplicate_identity: 409,
};

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

const LaunchQuery = z.object({ token: z.string().min(1).max(200) });

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, sessions } = deps;
  const hosts = allowedHosts(config.port);
  const origins = allowedOrigins(config.port);

  const app = Fastify({
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    logger: {
      level: config.env === "test" ? "warn" : "info",
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, url: redactUrl(req.url) }),
      },
      redact: ["req.headers.cookie", "req.headers.authorization", `req.headers["${CSRF_HEADER}"]`],
    },
  });

  app.decorateRequest("session", null);

  const media = createMediaStore(db, dataPaths(config.dataDir).media, deps.now);
  await media.init();

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(DOMAIN_STATUS[err.code]).send({ error: err.code, message: err.message });
    }
    if (err instanceof CredentialUnavailable) {
      return reply.code(503).send({ error: "keychain_unavailable", message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "validation", message: "The request was not valid.", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as { code?: string }).code ?? "bad_request", message: (err as Error).message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal", message: "Something went wrong. Details are in the server log." });
  });
  await app.register(cookie);

  app.addHook("onRequest", async (req, reply) => {
    if (!hosts.has(req.headers.host ?? "")) {
      return reply.code(421).send({ error: "invalid_host" });
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if ((req.url.startsWith("/api/") || req.url.startsWith("/launch")) && !reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/launch", async (req, reply) => {
    const parsed = LaunchQuery.safeParse(req.query);
    const sessionId = parsed.success ? sessions.exchangeLaunchToken(parsed.data.token) : null;
    if (!sessionId) {
      return reply
        .code(401)
        .type("text/plain; charset=utf-8")
        .send("This launch link has expired or was already used. Run `npm run open` for a new one.");
    }
    deps.onLaunchTokenUsed?.();
    // Loopback is plain HTTP, so `secure` stays off; a hosted deployment must use HTTPS + Secure.
    void reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: false,
      maxAge: SESSION_ABSOLUTE_TTL_MS / 1000,
    });
    // Redirecting drops the token from the address bar.
    return reply.code(303).header("location", "/").send();
  });

  const now = deps.now ?? (() => new Date());
  const accounts = createAccountsRepo(db, deps.now);
  const posts = createPostsRepo(db, accounts, deps.now);
  const services =
    deps.services ??
    createPlatformServices({
      db,
      accounts,
      credentials: deps.credentials,
      port: config.port,
      now,
      ...(deps.endpoints ? { endpoints: deps.endpoints } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      allowInsecureLoopback: config.env === "test",
    });
  registerOAuthCallbackPage(app);

  await app.register(async (api) => {
    api.addHook("preHandler", async (req, reply) => {
      if (!checkSameOrigin(req, reply, origins)) return reply;
      req.session = sessions.get(req.cookies[SESSION_COOKIE]);
      if (!req.session) return reply.code(401).send({ error: "not_authenticated" });
      if (isUnsafeMethod(req.method)) {
        const sent = req.headers[CSRF_HEADER];
        if (typeof sent !== "string" || !safeEqual(sent, req.session.csrfToken)) {
          return reply.code(403).send({ error: "invalid_csrf_token" });
        }
      }
    });

    registerAccountRoutes(api, accounts);
    await registerMediaRoutes(api, media);
    const { view } = registerPostRoutes(api, { accounts, posts, media });
    registerScheduleRoutes(api, {
      accounts,
      posts,
      media,
      schedule: createScheduleRepo(db, posts),
      view: (id) => view(posts.get(id)),
      now: deps.now ?? (() => new Date()),
      minLeadMs: config.minScheduleLeadMs,
      simulated: config.fakePlatforms,
      livePublishing: config.livePublishing,
    });
    registerConnectionRoutes(api, {
      accounts,
      posts,
      config: services.config,
      connections: services.connections,
      pinterest: services.pinterest,
      keychainStatus: deps.keychainStatus ?? (() => ({ ok: true, reason: null, kind: deps.credentials.kind })),
      livePublishing: config.livePublishing,
      view: (id) => view(posts.get(id)),
    });

    api.get("/session", async (req) => ({ authenticated: true, csrfToken: req.session!.csrfToken }));

    api.post("/session/logout", async (req, reply) => {
      sessions.destroy(req.cookies[SESSION_COOKIE]);
      void reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    });

    api.get("/status", async () => {
      const row = db.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: number | null };
      return {
        version: deps.version,
        environment: config.env,
        livePublishing: config.livePublishing ? "enabled" : "disabled",
        schemaVersion: row.v ?? 0,
      };
    });
  }, { prefix: "/api" });

  const webBuilt = existsSync(join(config.webRoot, "index.html"));
  if (webBuilt) {
    await app.register(fastifyStatic, { root: config.webRoot, index: "index.html", wildcard: false });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const wantsPage = req.method === "GET" && !req.url.startsWith("/api/") && (req.headers.accept ?? "").includes("text/html");
    if (wantsPage && webBuilt) return reply.type("text/html; charset=utf-8").sendFile("index.html");
    if (wantsPage) {
      return reply.code(503).type("text/plain; charset=utf-8").send("The web interface has not been built. Run `npm run build`.");
    }
    return reply.code(404).send({ error: "not_found" });
  });

  return app;
}
