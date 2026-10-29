// Temporary media delivery for Instagram, which fetches images from a public
// URL. One prepared derivative is uploaded to a private R2 bucket under a
// random key, exposed through a short-lived presigned GET URL, and deleted
// once Instagram has fetched it. A bucket lifecycle rule (1 day) is the
// backstop. Never exposes the database, the gallery, or anything else.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PlatformError } from "../domain/publishing.ts";
import type { Endpoints, HttpClient } from "../platforms/http.ts";
import { send } from "../platforms/oauth.ts";
import type { PlatformConfig } from "../storage/platform-config.ts";
import { EMPTY_SHA256, presignUrl, sha256Hex, signHeaders } from "./sigv4.ts";

/** Long enough for Instagram to fetch during container processing; short enough to limit exposure. */
export const PRESIGN_SECONDS = 15 * 60;
const SCOPE = { region: "auto", service: "s3" };

export interface StagedMedia {
  key: string;
  url: string;
}

export function createR2Stager(deps: { http: HttpClient; endpoints: Endpoints; config: PlatformConfig; now: () => Date }) {
  async function creds() {
    const c = await deps.config.r2Credentials();
    if (!c) {
      throw new PlatformError("permanent", "r2_not_configured", "Media delivery isn't set up. Add the Cloudflare R2 details in Settings › Platform setup.");
    }
    return c;
  }
  const objectUrl = (c: { accountId: string; bucket: string }, key: string) =>
    new URL(`/${c.bucket}/${key}`, deps.endpoints.r2(c.accountId));

  return {
    async stage(file: string): Promise<StagedMedia> {
      const c = await creds();
      const key = `staging/${randomUUID()}.jpg`;
      const body = await readFile(file);
      const url = objectUrl(c, key);
      const headers = signHeaders(
        { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
        SCOPE,
        { method: "PUT", url, headers: { "content-type": "image/jpeg" }, payloadHash: sha256Hex(body) },
        deps.now(),
      );
      const res = await send(deps.http, { method: "PUT", url, headers, body, timeoutMs: 60_000 });
      if (res.status !== 200) {
        throw new PlatformError(res.status === 403 ? "permanent" : "transient", `r2_${res.status}`, `Uploading to Cloudflare R2 failed (HTTP ${res.status}). Check the R2 settings.`);
      }
      const signed = presignUrl({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, SCOPE, "GET", url, PRESIGN_SECONDS, deps.now());
      return { key, url: signed.toString() };
    },

    /** Best effort: the bucket's lifecycle rule removes anything left behind. */
    async remove(key: string): Promise<void> {
      const c = await creds();
      const url = objectUrl(c, key);
      const headers = signHeaders({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, SCOPE, { method: "DELETE", url, payloadHash: EMPTY_SHA256 }, deps.now());
      await send(deps.http, { method: "DELETE", url, headers }).catch(() => undefined);
    },
  };
}

export type R2Stager = ReturnType<typeof createR2Stager>;
