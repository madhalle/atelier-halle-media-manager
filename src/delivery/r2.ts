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

    /**
     * Checks the saved settings end to end without publishing anything:
     * uploads a tiny object, reads it back through a presigned link (as
     * Instagram would), then deletes it. Each step fails with its own message.
     */
    async selfTest(): Promise<void> {
      const c = await creds();
      const signer = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
      const nonce = randomUUID();
      const body = Buffer.from(JSON.stringify({ check: nonce }));
      const url = objectUrl(c, `staging/connection-test-${nonce}.json`);

      const putHeaders = signHeaders(signer, SCOPE, { method: "PUT", url, headers: { "content-type": "application/json" }, payloadHash: sha256Hex(body) }, deps.now());
      const put = await send(deps.http, { method: "PUT", url, headers: putHeaders, body, timeoutMs: 30_000 }).catch((err: unknown) => {
        // Cloudflare refuses the TLS handshake for an unknown account ID, which looks like a network failure.
        if (err instanceof PlatformError && err.code === "http_network") {
          throw new PlatformError(
            "permanent",
            "r2_test_unreachable",
            `${err.safeMessage} Check the account ID: copy it from the bucket's Settings › S3 API address (https://<account ID>.r2.cloudflarestorage.com/…). If it's right, check your internet connection.`,
          );
        }
        throw err;
      });
      if (put.status !== 200) {
        const why =
          put.status === 403
            ? "Cloudflare refused the access key. Check the access key ID and secret, and that the token has Object Read & Write on this bucket."
            : put.status === 404
              ? "Cloudflare couldn't find the bucket. Check the account ID and bucket name."
              : `Cloudflare answered HTTP ${put.status}.`;
        throw new PlatformError("permanent", `r2_test_put_${put.status}`, `Upload failed. ${why}`);
      }

      let readError: PlatformError | null = null;
      const signed = presignUrl(signer, SCOPE, "GET", url, 60, deps.now());
      const get = await send(deps.http, { method: "GET", url: signed, timeoutMs: 30_000 }).catch((err: unknown) => {
        if (err instanceof PlatformError) return err;
        throw err;
      });
      if (get instanceof PlatformError) readError = get;
      else if (get.status !== 200 || (get.json as { check?: unknown } | null)?.check !== nonce) {
        readError = new PlatformError("permanent", `r2_test_get_${get.status}`, `Uploaded, but reading it back through a temporary link failed (HTTP ${get.status}).`);
      }

      // Always clean up, even when reading back failed.
      const delHeaders = signHeaders(signer, SCOPE, { method: "DELETE", url, payloadHash: EMPTY_SHA256 }, deps.now());
      const del = await send(deps.http, { method: "DELETE", url, headers: delHeaders });
      if (readError) throw readError;
      if (del.status !== 204 && del.status !== 200) {
        throw new PlatformError("permanent", `r2_test_delete_${del.status}`, `Uploaded and read back, but deleting failed (HTTP ${del.status}). The token needs Object Read & Write.`);
      }
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
