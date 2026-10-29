// Fastify application: one loopback origin serving the API and the built UI.
import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../storage/db.ts";
import type { Config } from "./config.ts";
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
}

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
  await app.register(cookie);

  app.addHook("onRequest", async (req, reply) => {
    if (!hosts.has(req.headers.host ?? "")) {
      return reply.code(421).send({ error: "invalid_host" });
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (req.url.startsWith("/api/") || req.url.startsWith("/launch")) reply.header("cache-control", "no-store");
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
