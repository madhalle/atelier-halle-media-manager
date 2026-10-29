# Local security model

## Trust boundary

The app protects your data from **websites open in your browser** and from
**other machines on your network**. It does **not** protect against a
compromised macOS installation or another program running as your macOS
user. Such a program can read the data directory, the launch file, and
Keychain items it is allowed to access. Use FileVault and encrypted backups.
The SQLite database is not separately encrypted.

## Network exposure

- The server binds to `127.0.0.1` only. Nothing listens on other interfaces.
- Every request needs an exact `Host` of `127.0.0.1:<port>` or
  `localhost:<port>`. Anything else gets `421`, which blocks DNS-rebinding
  attacks.
- There is no CORS. API requests are rejected when `Sec-Fetch-Site` is
  `cross-site` or `same-site`, or when `Origin` isn't one of this app's two
  exact origins. Unsafe methods must carry an `Origin`.

## Browser sessions

1. At startup, and again after each use or every 5 minutes, the server mints a
   random **launch token**.
   - It's single-use and expires after 10 minutes.
   - The server keeps only its SHA-256 digest.
2. The token is written into `launch.html`, a mode-`0600` file in the data
   directory. It's never printed or logged, and never passed as a process
   argument.
3. `npm run open` opens that file. The file sends the browser to
   `/launch?token=…`.
4. The server exchanges the token for a random session ID, set as an
   `HttpOnly; SameSite=Strict; Path=/` cookie. It then redirects to `/`, which
   removes the token from the address bar.
5. Sessions live only in server memory. They expire after 12 hours idle or 7
   days total. Restarting the server signs every browser out.
6. Unsafe API requests also need an `x-csrf-token` header that matches the
   session's CSRF token. The UI keeps that token in memory only, never in
   `localStorage`.

**Loopback limitations:**

- Cookies can't use `Secure` over plain-HTTP loopback.
- Browsers scope cookies by host, not port. Another local service on
  `127.0.0.1:<other port>` would receive the cookie if the browser visited it.
  That's a same-user or same-machine process, which is outside the trust
  boundary.
- A hosted version must use HTTPS, `Secure` cookies, and managed sign-in.

## Other controls

- **Security headers:** strict Content-Security-Policy (`default-src
  'self'`, no inline scripts, `frame-ancestors 'none'`), `nosniff`,
  `no-referrer`, COOP/CORP `same-origin`, and a restrictive
  `Permissions-Policy`. API responses are `no-store`.
- **Limits:** JSON bodies are capped at 1 MiB. Upload limits come with
  media handling (milestone 4).
- **Logging:** query strings are replaced with `?[redacted]`, and cookie,
  authorization and CSRF headers are redacted.
- **Filesystem:**
  - The process umask is `077`.
  - The data directories are `0700`, and the database, WAL and launch file
    are `0600`.
  - Paths built from input go through `containedPath`.
  - Static files are served only from the built UI directory.
- **Data separation:**
  - Development uses `.data/development` (gitignored).
  - Tests must use an explicit temporary directory.
  - Neither may point at the production data directory.
  - Live publishing can only be enabled in production.
- **Single instance:** a lock file in the data directory stops two servers
  from using the same data.

## Photo handling

- **Uploads:**
  - Uploads are streamed to `media/tmp`. Limits are 50 MB per file, 20 files
    per request, and no other form fields.
  - Uploads are refused when less than 1 GB of disk would remain.
- **Format checks** use the file's leading bytes (its magic number), never the
  file name or browser-supplied type. Only JPEG, PNG and WebP are accepted.
  HEIC/HEIF gets an explanation and is refused.
- **Decoder allowlist:** at startup the process blocks every libvips loader
  except JPEG, PNG and WebP (`sharp.block` / `sharp.unblock`). SVG, TIFF,
  GIF, PDF and the other parsers can't run on uploaded bytes even if the
  format check were bypassed. A test confirms this.
- **Pixel limits:** 100 megapixels and 20,000 px per side, checked from the
  header before decoding. Each upload is also fully decoded once, so damaged
  files are rejected at upload time, not at publishing time. At most two
  images are processed at once.
- **Originals:**
  - Originals are content-addressed by SHA-256, read-only (`0400`) and never
    modified. They keep their EXIF metadata, including location.
  - Identical uploads are stored once.
  - Uploaded file names are kept for display only. They're sanitized and
    never used in a path.
- **Derived images:** thumbnails (WebP, ≤480 px) and publishing derivatives
  (sRGB JPEG) are oriented and stripped of **all** metadata, including GPS.
- **Previews match uploads:** previews are the exact derivative file that
  would be uploaded, for the exact crop. Nothing is cropped without the user
  choosing it.
- **Storage hygiene:**
  - Derivatives are cached per crop and pruned when no post uses that crop.
  - On startup the store deletes files a crash left unreferenced.
  - Photos used by any post can't be deleted.
- **Text rendering:** captions and file names are always rendered as text by
  React. Nothing uses raw HTML insertion. A browser test checks this with a
  script-injection payload.

## Supply chain

- **Dependencies:**
  - Exact versions are pinned in `package.json`, and every package's
    integrity hash is locked in `package-lock.json`.
  - All packages resolve from the official npm registry.
- **Install scripts:** npm `allowScripts` stops dependency install scripts by
  default. `better-sqlite3` and `fsevents` are explicitly denied, because
  their prebuilt binaries work without them.
- **`npm run audit:deps`** reports known vulnerabilities, verifies npm
  registry signatures and provenance attestations, and lists any unreviewed
  install scripts. Run it after every dependency change.
- **Checked on 2026-10-29:**
  - 0 known vulnerabilities.
  - 134/134 registry signatures valid.
  - Every native-code dependency loaded by the server (`better-sqlite3`,
    `sharp` with its libvips binaries, `@napi-rs/keyring`) has an npm
    provenance attestation.
- **Node.js:** installed from the official tarball after checking SHA-256
  against `SHASUMS256.txt`. The binary carries a valid macOS Developer ID
  signature from the Node.js Foundation (team `HX7739G8FX`). The PGP
  signature of `SHASUMS256.txt` wasn't checked because `gpg` isn't installed.
- **Playwright's Chromium** is used only by tests, against loopback. It
  isn't code-signed. Remove it with `rm -rf ~/Library/Caches/ms-playwright`.
- **Residual risk:** signatures and provenance show that a package came
  unmodified from its publisher's build. They don't show that the publisher
  is trustworthy. The dependency list is kept deliberately small for that
  reason.

## Platform credentials (milestone 6)

- **Where secrets live:** only in the **macOS Keychain**, via `@napi-rs/keyring`:
  - platform access and refresh tokens
  - the Instagram and Pinterest app secrets
  - the R2 secret access key

  Service names are `com.atelierhalle.media-manager` in production and
  `….dev` in development. Tests use an in-memory store and never touch your
  Keychain.
- **What SQLite holds:** only opaque references (`cred:<uuid>`) and
  non-secret identifiers (app IDs, R2 account ID, bucket, access key ID).
- **No plaintext fallback.** If the Keychain can't be used:
  - saving a secret fails with an actionable 503;
  - publishing pauses as a transient error with "Keychain unavailable";
  - the hourly scheduler maintenance re-checks it.
  - `node scripts/keychain-probe.ts` verifies Keychain access on this Mac.
    It was verified interactively on 2026-10-29.
  - Background (LaunchAgent) access is checked in milestone 8.
- **The browser can write secrets but never read them.** The setup API
  reports only `secretSaved: true`. Secret fields are never pre-filled and
  are cleared from page state after saving.
- **Tests prove** that secrets and tokens don't appear in API responses,
  SQLite rows or server logs.
  - A repository scan (`npm run check:secrets`, part of `npm run check`)
    catches credential-shaped strings in tracked files. It stands in for
    GitHub secret scanning, which isn't available for this private repo.

## OAuth

- **Authorization-code flow with confidential, server-side exchange.**
  Neither platform documents PKCE, so it isn't used. See
  `docs/platform-capabilities.md`.
- **`state`:**
  - 32 random bytes, single-use, expiring after 10 minutes;
  - stored only as a SHA-256 digest;
  - **bound to the browser session that started the flow**;
  - at most 20 pending flows at a time.
  - A code with a wrong, reused, expired, cross-session or cross-platform
    `state` is never exchanged. Tests check each case.
- **Callback:**
  - The platform redirects to `http://localhost:<port>/oauth/<platform>/callback`
    (or `127.0.0.1`), which must exactly match the URI registered with the
    platform.
  - The callback page is static, with no inline script or style, and has the
    full Content-Security-Policy.
  - Its script moves to the canonical `127.0.0.1` origin where the session
    cookie lives, removes the code from the address bar and history, and
    posts `code` + `state` to `/api/oauth/<platform>/complete` with the
    session cookie and CSRF token.
  - Query strings are redacted from logs.
- **After the exchange**, the real identity and eligibility are checked
  (Instagram professional account and publish permission; Pinterest business
  account and required scopes) *before* any token is stored. Tokens from
  ineligible or duplicate identities are discarded.
- **Minimum scopes:**
  - Instagram: `instagram_business_basic`, `instagram_business_content_publish`
  - Pinterest: `user_accounts:read`, `boards:read`, `pins:read`, `pins:write`
- **Renewal** is serialized per account. Instagram tokens are renewed when
  less than 10 days remain (and at least 24 hours old); Pinterest when less
  than 1 day remains. Rotated refresh tokens are stored atomically.
- **Disconnecting** stops publishing first, then deletes the Keychain item.
  Neither platform supports revoking user tokens through the API, so the UI
  says to remove the app in the platform's own settings.

## Outbound network

- All server-side HTTP goes through one client (`src/platforms/http.ts`):
  - **exact origin allowlist**: Instagram, Pinterest (and sandbox), and the
    configured R2 account endpoint;
  - **HTTPS only** (plain HTTP only for loopback fakes in tests);
  - **no redirects followed**, no credentials in URLs;
  - 20 s timeouts (60 s for uploads) and a 2 MiB response cap.
  - Error messages never include URLs, query strings or response bodies.
    Provider error text is reduced to known fields, truncated, and
    long token-like strings are redacted.
- The server never fetches arbitrary URLs. Profile pictures aren't downloaded
  yet. When they are, it'll be from an allowlist of platform CDNs and through
  the image pipeline.

## Instagram media delivery (Cloudflare R2)

- Instagram fetches images from a public URL, so for each publish attempt
  **one prepared derivative** (sRGB JPEG with metadata stripped) is uploaded
  to a **private** bucket under a random key.
- Instagram gets a **15-minute presigned GET URL** for that one object.
- The object is deleted once Instagram reports the container `FINISHED` or
  `ERROR`. A 1-day bucket lifecycle rule is the backstop.
- Nothing else is ever exposed: not the database, the gallery, credentials,
  or the local server. There is no inbound tunnel.
- Requests are signed with AWS Signature V4, implemented on `node:crypto`
  with no dependencies and verified against AWS's published test vectors.
- **Instagram's copy:** deleting the staged object doesn't delete the copy
  Instagram has already fetched.

## Live publishing safeguards

- Real platform adapters are used only when all of these hold:
  - the server runs in production;
  - it was started with `MEDIA_MANAGER_LIVE_PUBLISHING=enabled`;
  - that platform's developer app is set up.
- Otherwise due posts are marked "not published". Simulated platforms are
  refused in production, and tests point at loopback fakes.
