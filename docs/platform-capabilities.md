# Platform capability matrix

**Verified on:** 2026-10-29, by reading official documentation and Pinterest's
official OpenAPI description. **Nothing below has been tested against a live
API yet.** No developer apps exist, no accounts have been connected, and nothing
has been published. Each row is labeled with how it was confirmed.

Legend: **Doc** = stated in official docs on the verification date.
**Spec** = stated in Pinterest's machine-readable OpenAPI file.
**Unverified** = not stated, conflicting, or needs a live test.

## Selected API versions

| Platform | API | Version |
|---|---|---|
| Instagram | Instagram API with Instagram Login (`graph.instagram.com`) | Graph API `v26.0` (version used in current examples; pin explicitly in requests) |
| Pinterest | Pinterest REST API | `v5` (OpenAPI description `5.28.0`) |

Why Instagram Login rather than Facebook Login: it needs no linked Facebook
Page, uses fewer permissions (`instagram_business_basic`,
`instagram_business_content_publish`), and is enough for publishing to
professional accounts the user owns.

## Matrix

| Topic | Instagram | Pinterest |
|---|---|---|
| **Eligible accounts** | Instagram *professional* accounts only (Business or Creator). Doc. Accounts linked to a Page that requires Page Publishing Authorization cannot publish until it's completed. Doc | The developer app must be administered from a Pinterest **business** account. Doc. Apps registered on or after 2026-09-14 may get HTTP 403 `PINNER_DATA_ACCESS_DENIED` for **non-business** users unless Pinterest authorizes it. Doc. **Plan on every posting account being a business account.** Unverified for this user's app until tested. |
| **Developer registration** | Meta developer account and a Meta app with the Instagram product, configured for "API setup with Instagram login". Doc | Business account, verified email, accept Developer Terms, create app, request **Trial** access, which Pinterest reviews. Doc. A reachable, accurate **privacy policy URL** and use-case description are required for approval. Doc (listed denial reasons) |
| **Review / access levels** | **Standard Access** covers professional accounts you own or manage and have added to the app in the App Dashboard. **Advanced Access** (App Review) is needed only for accounts you don't own. Doc. Each account is added as an **Instagram tester** under App roles, so tokens can be issued. Doc (create-an-app). The same page also says "Instagram requires successful completion of the App Review process before your app can access live data" and that publishing the *app* (Live mode) needs Business Verification. **Expected path:** keep the app in Development mode, with every posting account as a tester, and skip App Review. Unverified until a tester account publishes. | **Trial** = sandbox only. Pins and boards are visible only to you, not on the public profile. **Standard** = production, which needs an upgrade request with a screen recording of the OAuth flow, even for a single user. Doc |
| **Permissions / scopes** | `instagram_business_basic`, `instagram_business_content_publish`. Doc | `user_accounts:read` (identity), `boards:read` (board picker), `pins:write` (create), `pins:read` (reconciliation). `*_secret` scopes only if secret boards are wanted. Spec |
| **OAuth authorize URL** | `https://www.instagram.com/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`. Doc | `https://www.pinterest.com/oauth/` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`. Doc |
| **PKCE** | **Not supported as far as the docs show.** The authorize endpoint reference lists only `client_id`, `redirect_uri`, `response_type`, `scope`, `state`. Doc (oauth-authorize reference, 2026-10-29). Use a confidential server-side code exchange with single-use, expiring `state`. If PKCE is ever added, sending `code_challenge` is harmless to try, but don't depend on it. | **Not officially documented.** The auth guide, the OpenAPI spec, and the official `api-quickstart` code have no `code_challenge`. Third-party guides claim it works. Treat it as unsupported and rely on `state` plus the confidential exchange. A live test could send `code_challenge` and see whether the token call enforces `code_verifier`. |
| **Redirect URI** | Exact match required. Meta requires **Strict Mode** for all apps and recommends HTTPS ("Enforce HTTPS"), which is on by default for apps created since March 2018. Doc (Facebook Login security). **Neither page says whether `http://localhost` or `https://localhost` is accepted for Instagram Login. This can't be settled from the docs.** It takes about 5 minutes in the App Dashboard to try saving each form. The redirect is a browser redirect, so the callback doesn't have to be reachable from the internet. | **Plain `http://localhost` is used by Pinterest's official quickstart** (`http://localhost:8085/`), and the auth guide example uses `http://localhost/`. Doc + official code. Exact match required, and no secondary redirect. |
| **Token exchange** | Code (valid 1 h, single use) → `POST https://api.instagram.com/oauth/access_token` (short-lived) → `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` (long-lived). Needs the **app secret**, so it must run server-side. Doc | `POST https://api.pinterest.com/v5/oauth/token` with HTTP Basic `client_id:client_secret`. Doc |
| **Token expiry / renewal** | Long-lived token lasts **60 days**. Renew with `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` once it's ≥24 h old and not expired. If not refreshed within 60 days, it can't be renewed. Doc | Access token lasts **30 days** (`expires_in` 2592000). Refresh tokens are **continuous**: they expire after 60 days but can be renewed indefinitely, and responses include `refresh_token_expires_at`. Doc |
| **Revocation** | **No revocation API is documented for Instagram Login** (none in the business-login, create-an-app, or access-token pages). The app dashboard has a **Deauthorize callback URL** and a **Data deletion request URL**. Doc. On disconnect: delete local tokens, then tell the user to remove the app in Instagram's settings. An unused token stops working once 60 days pass without a refresh. | **Revocation of user tokens isn't available.** `POST /v5/oauth/token/revoke` exists, but the spec says "Only tokens issued for system users are currently supported." Spec. On disconnect: delete local tokens and tell the user to remove the app's access in Pinterest settings. Otherwise the refresh token lapses after 60 days without use. |
| **Identity verification** | `GET /me?fields=user_id,username,profile_picture_url,account_type` on `graph.instagram.com`. Field set needs a live test. | `GET /v5/user_account` returns `id`, `username`, `account_type`, `profile_image`, `business_name`. Spec |
| **Publishing fields** | `caption` (≤2200 chars, ≤30 hashtags, ≤20 @mentions). `alt_text` (≤1000 chars, images only, added 2025-03-24). Also `location_id` and `user_tags`, which are deferred and not exposed. Doc | `board_id` (required in practice), `board_section_id`, `title` (≤100), `description` (≤800), `link` (≤2048), `alt_text` (≤500). Spec. `ai_disclosures` exists in the spec but is not exposed for now. |
| **Hashtags** | Part of `caption`. There is no separate tagging API. Doc | Part of `description`. There is no separate tagging field. Spec |
| **Image constraints** | **JPEG only**, ≤8 MB, aspect ratio **4:5 to 1.91:1**, width 320–1440 (scaled otherwise), sRGB (others converted). Doc. Carousels are cropped to the first image (default 1:1). Doc | `image/jpeg` or `image/png` for base64 uploads. Spec. Size and dimension limits are not in the spec. Unverified |
| **Upload method** | **`image_url` only: Meta fetches the image from a public URL.** Direct byte upload is documented only for video. Doc. **Localhost can't satisfy this.** | **`image_base64`: direct bytes in the request.** Spec. No public URL is needed. `image_url` also exists. |
| **Flow** | 1) `POST /<IG_ID>/media` → container `id`. 2) Optionally poll `GET /<container>?fields=status_code` (`IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED`, `PUBLISHED`). 3) `POST /<IG_ID>/media_publish` with `creation_id` → media `id`. Containers expire after 24 h. Doc | A single synchronous `POST /v5/pins` returns the Pin. Spec |
| **Rate limits** | **Conflicting docs.** The content-publishing guide says "100 API-published posts within a 24-hour moving period" and, in its carousel section, "50 published posts within a 24-hour period". The `content_publishing_limit` reference says `quota_total` is "currently 50" containers per `quota_duration` 86400 s. Doc. **Design rule: read `config.quota_total` and `quota_usage` from `GET /<IG_ID>/content_publishing_limit` before each publish and never hardcode the limit.** Either number is far above this app's needs. | Official table (2026-10-29), "subject to change without notice". Universal: Trial **1,000/day per app**; Standard **100/s per user per app**. Pin create is `org_write`: Trial **300/day per app**, Standard **100/min per user per app**. `org_read`: 1,000/day and 1,000/min. Headers: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`. Doc |
| **Progress / reconciliation** | Persist the container ID right after step 1. If `media_publish` times out, read the container `status_code`: `PUBLISHED` means it succeeded, so find the media ID via `GET /<IG_ID>/media`. `FINISHED` with no matching media is still **ambiguous**, so it needs review rather than a blind retry. Doc + design | There's no idempotency key, so a lost response is ambiguous. Reconcile by listing the board's recent Pins (`GET /v5/boards/{id}/pins`) and matching on title, description, and creation time. Anything uncertain needs review. Design; needs a live test |
| **Sandbox vs. public** | No sandbox. A successful `media_publish` is publicly visible. | Trial/sandbox (`api-sandbox.pinterest.com`) Pins are private to the developer. **Only Standard access produces publicly visible Pins.** Doc |

## Consequences for this application

1. **Instagram publishing needs external media delivery.** Meta must fetch a
   JPEG from a public URL at publish time. The leading option is a private
   object-storage bucket (for example Cloudflare R2) that holds **one prepared
   derivative per publish attempt**, behind a short-lived presigned GET URL, and
   deletes it afterwards. This needs an account with a third-party provider. Its
   free tier and billing terms have to be checked, and the user must authorize
   it explicitly (milestone 7). It's also unverified whether Meta's fetcher
   accepts presigned URLs with query strings. **Until this is set up,
   Instagram accounts can draft and schedule, but due posts go to "needs
   attention" with a clear reason instead of publishing.**
2. **Pinterest needs no inbound or public media infrastructure.** Images go as
   base64. Public Pins need Standard access, which needs a demo video and a
   hosted privacy policy. In Trial, "published" Pins are sandbox Pins, and the
   UI must label them that way.
3. **OAuth callbacks are browser redirects to loopback.** No tunnel is needed
   if each platform accepts a loopback redirect URI. If Meta requires HTTPS,
   loopback TLS with a locally trusted certificate is the first thing to try.
   A public callback helper is a last resort and needs authorization.
4. **App secrets are confidential** (Instagram long-lived token exchange,
   Pinterest HTTP Basic). In this single-user local tool the user is the
   developer, so they're kept in the macOS Keychain and never shipped to the
   browser. A future downloadable app could not embed them and would need a
   confidential server component.
5. **Account conversion.** Publishing to Instagram needs each target account
   to be professional (Business or Creator). Converting a personal account
   changes how it behaves, for example whether the account can stay private
   and which profile options are available. These effects haven't been
   verified here. Check the current Instagram Help Center and discuss it with
   the user before asking for any conversion. Pinterest posting
   accounts should be business accounts. Converting is free, but check the
   effects first.
6. **Image preparation:** Instagram derivatives are JPEG, sRGB, ≤1440 px wide,
   ≤8 MB, aspect 4:5–1.91:1, with **explicit, previewed** crops. Pinterest
   derivatives are JPEG or PNG, sRGB, with location metadata stripped.

## Instagram enablement plan (Business accounts only)

**Proposed. Nothing here has been set up.** Steps 1–3 are done by the user in
Meta's dashboard. Step 4 needs explicit authorization because it creates an
external account.

1. **Meta app.** Create a Meta developer account and an app with the
   Instagram product, set to "API setup with Instagram login". There's no
   Facebook Page requirement. Request only `instagram_business_basic` and
   `instagram_business_content_publish`.
2. **Testers, not App Review.** Add each Instagram Business account under App
   roles as an Instagram tester, then accept the invite from that account.
   Keep the app in Development mode. Standard Access covers accounts you own.
   Docs also mention App Review for "live data", so the first live connection
   is what confirms this path.
3. **Redirect URI.** In Business login settings, try saving
   `http://localhost:<port>/oauth/instagram/callback`. If it's rejected, try
   `https://localhost:<port>/...`. The Deauthorize callback and Data deletion
   fields can point at loopback pages that explain the app is local and
   personal. Whichever URI is accepted decides whether the app needs a loopback
   TLS listener for the callback.
4. **Media delivery (the only external piece).** **Decision (2026-10-29):
   the user selected Cloudflare R2.** It's built as a swappable module
   behind an S3-compatible interface, and no account exists yet. Meta must
   fetch a JPEG from a
   public URL. Recommended setup: a private **Cloudflare R2** bucket.
   - The app uploads **one** prepared derivative with a random key just before
     creating the container.
   - Meta gets a **presigned GET URL** for that object, valid for 15–60 minutes.
     A presigned URL is a bearer token for one object. Presigned URLs only work
     on the S3 endpoint, not custom domains. Doc.
   - The object is deleted after the container reports `FINISHED`, `ERROR`, or
     `EXPIRED`. A 1-day bucket lifecycle rule is the backstop.
   - The R2 API token is scoped to that one bucket and stored in the Keychain.
   - Free allowance: 10 GB-month storage, 1M Class A and 10M Class B ops per
     month, free egress. Doc (R2 pricing). This app's use is a tiny fraction
     of that.
   - **Not confirmed:** whether a payment method is required to enable R2, and
     how overage billing works. The free allowance is not a spending cap.
   - Deleting the staged object doesn't delete Meta's copy.
   - Equivalent alternative: **Google Cloud Storage** (private bucket +
     signed URLs). Always Free: 5 GB-month in `us-east1`, `us-west1`, or
     `us-central1`; 5,000 Class A and 50,000 Class B ops per month; 100 GB
     egress from North America. **Needs a billing account with a payment
     method.** Doc (Google Cloud free tier).
   - Rejected alternatives:
     - Google Photos Library API: since 2025-03-31 it can only read back
       app-created items. It has no delete call, so every post would stay in
       the user's library. Its temporary image links can't be relied on to
       work without sign-in or to be shareable with Meta. Doc (Google Photos
       updates, access-media-items).
     - Google Drive "anyone with the link": not a stable direct-JPEG URL,
       and files stay public until unshared;
     - a permanent tunnel into the local backend (exposes the backend);
     - public image hosts (privacy);
     - AWS S3 (no lasting free tier).
5. **Safe pre-publication proof.** Creating a container (`POST /<IG_ID>/media`)
   doesn't publish anything. Only `media_publish` does, and unpublished
   containers expire in 24 h. So the app can verify the token, account
   eligibility, the R2 presigned URL, and JPEG preparation by creating a
   container and polling until `status_code=FINISHED`, **without publishing**.
   Only then is one explicitly authorized `media_publish` done.

Until step 4 is authorized, Instagram accounts can draft, preview, and schedule.
Due posts move to "needs attention: media delivery not configured" and are
never reported as published.

## Implementation notes (milestone 6): assumptions to confirm live

These are built and tested against loopback fakes that use the documented
response shapes. They haven't been checked against the real APIs.

- **Instagram account ID:** the app publishes as `user_id` from
  `GET /v26.0/me` (falling back to `id`). The docs call the publishing ID the
  "IG professional account ID". Confirm on the first connection.
- **Instagram sign-in:** the authorize URL includes `force_reauth=true`, so
  the account picker always appears.
- **Instagram tokens:** access tokens are sent as the documented
  `access_token` query or form parameter, never logged. Instagram accepts
  `Authorization: Bearer` headers; that hasn't been tested.
- **Instagram quota:** `content_publishing_limit` is read before each publish
  instead of assuming 50 or 100.
- **Pinterest Trial:** Pins are created on `api-sandbox.pinterest.com`, while
  OAuth and boards use `api.pinterest.com`. Whether a Trial access token works
  against the sandbox endpoint as-is needs a live test.
- **Pinterest reconciliation:** looks for a Pin on the board with the same
  title and description, created after the attempt started. It reports
  "not published" only after 5 minutes without finding one.
- **Instagram reconciliation:** uses the persisted container's `status_code`.
  `PUBLISHED` means it went out. `FINISHED` means it didn't, but only once 5
  minutes have passed.

## Live verification checklist (in progress)

Each item needs explicit user authorization where it publishes.

- [x] R2 (2026-10-31): bucket-scoped token works for SigV4 PUT, presigned GET
      and DELETE against the real account (Platform setup › Test connection).
      Finding: a wrong account ID makes Cloudflare fail the TLS handshake
      (alert 40) rather than return an HTTP error.

- [ ] Instagram: register app; confirm accepted redirect URI form (http vs https loopback).
- [ ] Instagram: connect each intended account; record `account_type` and identity fields.
- [ ] Instagram: long-lived exchange; refresh after 24 h; record actual `expires_in`.
- [ ] Instagram: confirm Development mode + tester role allows publishing (no App Review).
- [ ] Instagram: read `content_publishing_limit` → record actual `quota_total` (50 vs 100).
- [ ] Instagram: confirm presigned object-store URL is fetchable by Meta (container reaches `FINISHED`, no publish).
- [ ] Both: try `code_challenge`; record whether `code_verifier` is enforced.
- [ ] Instagram: one authorized single-image publication.
- [ ] Pinterest: register app; Trial approval; confirm loopback redirect.
- [ ] Pinterest: connect each intended account; confirm no `PINNER_DATA_ACCESS_DENIED`.
- [ ] Pinterest: sandbox Pin via `image_base64`; then Standard upgrade.
- [ ] Pinterest: one authorized public single-image Pin; token refresh; revoke.

## Sources

- Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/
- Instagram Login (business login, tokens): https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- IG User Media reference (image specs, fields): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- Pinterest app registration: https://developers.pinterest.com/docs/getting-started/connect-app/
- Pinterest authentication: https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
- Pinterest access tiers: https://developers.pinterest.com/docs/key-concepts/access-tiers/
- Pinterest OpenAPI description (v5, 5.28.0): https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml
- Pinterest official examples: https://github.com/pinterest/api-quickstart
- Instagram authorize endpoint reference: https://developers.facebook.com/documentation/instagram-platform/reference/oauth-authorize.md
- Instagram create an app: https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app.md
- Instagram content publishing limit: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
- Meta login security (Strict Mode, Enforce HTTPS): https://developers.facebook.com/docs/facebook-login/security
- Pinterest rate limits: https://developers.pinterest.com/docs/reference/rate-limits.md
- R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/

The plan's Meta links (a Postman collection and a GitHub catalogue) are
secondary. The developers.facebook.com pages above are treated as
authoritative.
