// Pinterest API v5 adapter: standard single-image Pins via direct base64 upload
// (no public media URL needed). Trial apps publish to the sandbox, where Pins
// are visible only to the developer; Standard access publishes publicly.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Account } from "../domain/accounts.ts";
import { PlatformError } from "../domain/publishing.ts";
import type { PlatformConfig } from "../storage/platform-config.ts";
import { classifyResponse, send } from "./oauth.ts";
import type { Endpoints, HttpClient } from "./http.ts";
import type { TokenManager } from "./tokens.ts";
import type { PlatformAdapter, PublishJob, ReconcileResult } from "./types.ts";

const PinCreated = z.object({ id: z.union([z.string(), z.number()]) });
const PinList = z.object({
  items: z.array(z.object({ id: z.union([z.string(), z.number()]), created_at: z.string().optional(), title: z.string().nullable().optional(), description: z.string().nullable().optional() })),
});
const BoardList = z.object({
  items: z.array(z.object({ id: z.union([z.string(), z.number()]), name: z.string(), privacy: z.string().optional() })),
  bookmark: z.string().nullable().optional(),
});

/** How long after an uncertain publish we keep looking before concluding it didn't go out. */
const SETTLE_MS = 5 * 60_000;

export interface Board {
  id: string;
  name: string;
  privacy: string | null;
}

export function createPinterestAdapter(deps: { http: HttpClient; endpoints: Endpoints; tokens: TokenManager; config: PlatformConfig; now: () => Date }) {
  const base = () => (deps.config.view().pinterest.tier === "standard" ? deps.endpoints.pinterestApi : deps.endpoints.pinterestSandboxApi);
  const auth = async (job: Pick<PublishJob, "credentialRef">) => ({
    authorization: `Bearer ${await deps.tokens.accessToken({ platform: "pinterest", credentialRef: job.credentialRef })}`,
    accept: "application/json",
  });

  const adapter: PlatformAdapter & { listBoards(account: Pick<Account, "credentialRef">): Promise<Board[]> } = {
    platform: "pinterest",
    simulated: false,

    async stage() {
      return { containerId: null };
    },

    async checkStaged() {
      return "ready";
    },

    async commit(job) {
      if (!job.pinBoardId) throw new PlatformError("permanent", "no_board", "Choose a board for this Pin.");
      const data = (await readFile(job.derivative.file)).toString("base64");
      const body: Record<string, unknown> = {
        board_id: job.pinBoardId,
        media_source: { source_type: "image_base64", content_type: "image/jpeg", data },
      };
      if (job.pinTitle) body.title = job.pinTitle;
      if (job.pinDescription) body.description = job.pinDescription;
      if (job.pinLink) body.link = job.pinLink;
      if (job.altText) body.alt_text = job.altText;
      const res = await send(deps.http, {
        method: "POST",
        url: new URL("/v5/pins", base()),
        headers: { ...(await auth(job)), "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      });
      if (res.status !== 200 && res.status !== 201) throw classifyResponse("pinterest", res, "create the Pin");
      const pin = PinCreated.safeParse(res.json);
      if (!pin.success) throw new PlatformError("ambiguous", "bad_pin_response", "Pinterest answered, but not in the expected format.");
      const id = String(pin.data.id);
      const sandbox = deps.config.view().pinterest.tier !== "standard";
      return { remotePostId: id, permalink: sandbox ? null : `https://www.pinterest.com/pin/${encodeURIComponent(id)}/` };
    },

    async reconcile(job, commitStartedAt): Promise<ReconcileResult> {
      if (!job.pinBoardId) return { state: "not_published" };
      const url = new URL(`/v5/boards/${encodeURIComponent(job.pinBoardId)}/pins`, base());
      url.searchParams.set("page_size", "25");
      const res = await send(deps.http, { method: "GET", url, headers: await auth(job) });
      if (res.status !== 200) throw classifyResponse("pinterest", res, "check whether the Pin was created");
      const list = PinList.safeParse(res.json);
      if (!list.success) throw new PlatformError("transient", "bad_list_response", "Pinterest answered, but not in the expected format.");
      const since = commitStartedAt.getTime() - 2 * 60_000;
      const match = list.data.items.find(
        (p) =>
          (p.title ?? "") === job.pinTitle &&
          (p.description ?? "").trim() === job.pinDescription.trim() &&
          (p.created_at === undefined || Date.parse(p.created_at.endsWith("Z") ? p.created_at : `${p.created_at}Z`) >= since),
      );
      if (match) {
        const sandbox = deps.config.view().pinterest.tier !== "standard";
        const id = String(match.id);
        return { state: "published", remotePostId: id, permalink: sandbox ? null : `https://www.pinterest.com/pin/${encodeURIComponent(id)}/` };
      }
      // A just-created Pin may not be listed yet: keep checking before concluding.
      if (deps.now().getTime() - commitStartedAt.getTime() < SETTLE_MS) {
        throw new PlatformError("transient", "not_visible_yet", "Still checking whether the Pin was created.");
      }
      return { state: "not_published" };
    },

    async listBoards(account) {
      if (!account.credentialRef) throw new PlatformError("auth_expired", "not_connected", "This account isn't connected.");
      const boards: Board[] = [];
      let bookmark: string | null = null;
      for (let page = 0; page < 5; page++) {
        const url = new URL("/v5/boards", deps.endpoints.pinterestApi);
        url.searchParams.set("page_size", "100");
        if (bookmark) url.searchParams.set("bookmark", bookmark);
        const res = await send(deps.http, { method: "GET", url, headers: await auth({ credentialRef: account.credentialRef }) });
        if (res.status !== 200) throw classifyResponse("pinterest", res, "list your boards");
        const parsed = BoardList.safeParse(res.json);
        if (!parsed.success) throw new PlatformError("transient", "bad_board_list", "Pinterest answered, but not in the expected format.");
        boards.push(...parsed.data.items.map((b) => ({ id: String(b.id), name: b.name, privacy: b.privacy ?? null })));
        bookmark = parsed.data.bookmark ?? null;
        if (!bookmark) break;
      }
      return boards;
    },
  };
  return adapter;
}

export type PinterestAdapter = ReturnType<typeof createPinterestAdapter>;
