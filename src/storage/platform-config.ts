// Developer-app configuration for each platform and for R2 media delivery.
// Identifiers live in SQLite; secrets live only in the credential store
// (Keychain). The API reports whether a secret is saved, never its value.
import { z } from "zod";
import { DomainError } from "../domain/errors.ts";
import type { CredentialStore } from "./credentials.ts";
import type { Db } from "./db.ts";

export type RedirectHost = "localhost" | "127.0.0.1";

export interface PlatformConfigView {
  instagram: { clientId: string | null; secretSaved: boolean; redirectHost: RedirectHost };
  pinterest: { clientId: string | null; secretSaved: boolean; redirectHost: RedirectHost; tier: "trial" | "standard" };
  r2: { accountId: string | null; bucket: string | null; accessKeyId: string | null; secretSaved: boolean };
}

const SECRET_REFS = {
  instagram: "app:instagram:client_secret",
  pinterest: "app:pinterest:client_secret",
  r2: "app:r2:secret_access_key",
} as const;

const clientId = z.string().trim().regex(/^\d{5,25}$/, "App IDs are numbers.");
const secret = z.string().trim().regex(/^[\x21-\x7e]{16,512}$/, "That doesn't look like an app secret.");
const PatchSchema = z
  .object({
    instagram: z.object({ clientId: clientId.nullable(), clientSecret: secret, redirectHost: z.enum(["localhost", "127.0.0.1"]) }).partial().strict(),
    pinterest: z
      .object({ clientId: clientId.nullable(), clientSecret: secret, redirectHost: z.enum(["localhost", "127.0.0.1"]), tier: z.enum(["trial", "standard"]) })
      .partial()
      .strict(),
    r2: z
      .object({
        accountId: z.string().trim().regex(/^[a-f0-9]{32}$/, "The R2 account ID is 32 hex characters.").nullable(),
        bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "Bucket names use lowercase letters, numbers and hyphens.").nullable(),
        accessKeyId: z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/, "That doesn't look like an R2 access key ID.").nullable(),
        secretAccessKey: z.string().trim().regex(/^[A-Za-z0-9/+=]{20,128}$/, "That doesn't look like an R2 secret access key."),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

export type PlatformConfigPatch = z.infer<typeof PatchSchema>;
export { PatchSchema as PlatformConfigPatchSchema };

export function createPlatformConfig(db: Db, credentials: CredentialStore, now: () => Date = () => new Date()) {
  const get = (key: string) => db.prepare<[string], { value: string }>("SELECT value FROM app_settings WHERE key = ?").get(key)?.value ?? null;
  const put = (key: string, value: string | null) => {
    if (value === null) db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
    else
      db.prepare(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).run(key, value, now().toISOString());
  };
  const flag = (key: string) => get(key) === "1";

  async function setSecret(kind: keyof typeof SECRET_REFS, value: string): Promise<void> {
    await credentials.set(SECRET_REFS[kind], value);
    put(`${kind}.secret_saved`, "1");
  }

  return {
    view(): PlatformConfigView {
      return {
        instagram: { clientId: get("instagram.client_id"), secretSaved: flag("instagram.secret_saved"), redirectHost: (get("instagram.redirect_host") as RedirectHost) ?? "localhost" },
        pinterest: {
          clientId: get("pinterest.client_id"),
          secretSaved: flag("pinterest.secret_saved"),
          redirectHost: (get("pinterest.redirect_host") as RedirectHost) ?? "localhost",
          tier: get("pinterest.tier") === "standard" ? "standard" : "trial",
        },
        r2: { accountId: get("r2.account_id"), bucket: get("r2.bucket"), accessKeyId: get("r2.access_key_id"), secretSaved: flag("r2.secret_saved") },
      };
    },

    async update(input: unknown): Promise<PlatformConfigView> {
      const parsed = PatchSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid settings.");
      const p = parsed.data;
      if (p.instagram) {
        if (p.instagram.clientId !== undefined) put("instagram.client_id", p.instagram.clientId);
        if (p.instagram.redirectHost) put("instagram.redirect_host", p.instagram.redirectHost);
        if (p.instagram.clientSecret) await setSecret("instagram", p.instagram.clientSecret);
      }
      if (p.pinterest) {
        if (p.pinterest.clientId !== undefined) put("pinterest.client_id", p.pinterest.clientId);
        if (p.pinterest.redirectHost) put("pinterest.redirect_host", p.pinterest.redirectHost);
        if (p.pinterest.tier) put("pinterest.tier", p.pinterest.tier);
        if (p.pinterest.clientSecret) await setSecret("pinterest", p.pinterest.clientSecret);
      }
      if (p.r2) {
        if (p.r2.accountId !== undefined) put("r2.account_id", p.r2.accountId);
        if (p.r2.bucket !== undefined) put("r2.bucket", p.r2.bucket);
        if (p.r2.accessKeyId !== undefined) put("r2.access_key_id", p.r2.accessKeyId);
        if (p.r2.secretAccessKey) await setSecret("r2", p.r2.secretAccessKey);
      }
      return this.view();
    },

    /** Removes a platform's app secret from the Keychain and its identifiers from the database. */
    async clear(kind: keyof typeof SECRET_REFS): Promise<PlatformConfigView> {
      await credentials.delete(SECRET_REFS[kind]);
      put(`${kind}.secret_saved`, null);
      if (kind === "r2") {
        for (const k of ["r2.account_id", "r2.bucket", "r2.access_key_id"]) put(k, null);
      } else {
        put(`${kind}.client_id`, null);
      }
      return this.view();
    },

    /** Server-only: the app credentials needed for OAuth, or null if incomplete. */
    async appCredentials(platform: "instagram" | "pinterest"): Promise<{ clientId: string; clientSecret: string } | null> {
      const id = get(`${platform}.client_id`);
      if (!id || !flag(`${platform}.secret_saved`)) return null;
      const s = await credentials.get(SECRET_REFS[platform]);
      return s ? { clientId: id, clientSecret: s } : null;
    },

    /** Server-only: R2 credentials, or null if incomplete. */
    async r2Credentials(): Promise<{ accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string } | null> {
      const v = this.view().r2;
      if (!v.accountId || !v.bucket || !v.accessKeyId || !v.secretSaved) return null;
      const s = await credentials.get(SECRET_REFS.r2);
      return s ? { accountId: v.accountId, bucket: v.bucket, accessKeyId: v.accessKeyId, secretAccessKey: s } : null;
    },

    isConfigured(platform: "instagram" | "pinterest"): boolean {
      return get(`${platform}.client_id`) !== null && flag(`${platform}.secret_saved`);
    },
  };
}

export type PlatformConfig = ReturnType<typeof createPlatformConfig>;
