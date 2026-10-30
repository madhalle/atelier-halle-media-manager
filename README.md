# Atelier Halle Media Manager

A local-first macOS app for preparing, scheduling and publishing photo posts
to multiple Instagram and Pinterest business accounts, through the platforms'
official APIs, without opening the social apps.

Built for a small creative business that posts the same work across several
accounts and wants a calm, reliable workflow: one photo library, per-platform
captions and crops, and posts that go out on time, exactly once.

## What it does

- **Multiple accounts, one library.** Add any number of Instagram and
  Pinterest accounts. Upload photos once (deduplicated by content hash) and
  reuse them across accounts.
- **Platform-aware composer.** Captions, alt text, Pin titles, links and
  boards, with each platform's limits validated live and an exact preview of
  the crop that will be published.
- **Scheduling that respects real time zones.** Explicit IANA time zones,
  with daylight-saving gaps and overlaps resolved explicitly instead of guessed.
- **Reliable publishing.** A durable background scheduler publishes through
  the Instagram Graph API and Pinterest API v5, retries safely, respects rate
  limits, and **never double-posts**: if a platform's response is lost, it
  checks what actually happened before doing anything else.
- **Secure account connections.** OAuth sign-in; every token and app secret
  is stored only in the macOS Keychain.
- **Backups and recovery.** Automatic daily and pre-upgrade backups that cost
  no extra disk space, with verification, export and a safe restore.

## Architecture

```
 Browser (React) ──HTTP, 127.0.0.1 only──▶ Fastify server (Node.js, TypeScript)
                                            ├─ SQLite (WAL): accounts, posts, schedule, history
                                            ├─ Photo library: content-addressed, read-only originals
                                            ├─ macOS Keychain: OAuth tokens and app secrets
                                            └─ Scheduler (polls SQLite, leases jobs)
                                                 ├─▶ Pinterest API v5 (direct image upload)
                                                 └─▶ Instagram Graph API
                                                       └─ image staged in private Cloudflare R2,
                                                          shared by a 15-minute presigned URL
```

Everything runs on one Mac. There is no hosted backend, no account system, and
no inbound network access. See the [architecture decision record](docs/adr/0001-architecture.md).

## Engineering highlights

**Publishing exactly once.** Social APIs have no idempotency keys, and a
network failure after the "publish" call leaves the outcome unknown. The
scheduler claims each job with an atomic `UPDATE … RETURNING` lease, records a
durable marker *before* the irreversible call, and on any uncertain outcome
**reconciles** against the platform instead of retrying blindly. Failures are
classified (transient, rate-limited, auth-expired, permanent, ambiguous) with
bounded, jittered backoff. Details: [docs/scheduling.md](docs/scheduling.md).

**Security by design.** See [docs/security.md](docs/security.md).
- Loopback-only server with Host and Origin checks, a single-use launch token
  exchanged for an HttpOnly SameSite=Strict cookie, CSRF tokens, and a strict
  Content Security Policy with no inline script or style.
- OAuth with single-use, session-bound, expiring state; codes exchanged on the
  server; identity and account eligibility verified before anything is saved.
- Secrets only in the Keychain, never in the database, logs, API responses
  or the browser, and never silently falling back to plaintext.
- Outbound requests restricted to an exact allowlist of HTTPS origins, with
  redirects refused, timeouts, response size caps and sanitized errors.
- Uploaded images are verified by magic bytes, decoded only by allowlisted
  libvips loaders with pixel limits, and every published copy is re-encoded
  with all metadata (including GPS) removed.
- AWS Signature V4 for R2 implemented directly on `node:crypto` (no SDK),
  verified against AWS's published test vectors.
- Supply chain: exact lockfile, install scripts denied by default, registry
  signature and provenance checks, and a secret scanner that runs with every check.

**Efficient local storage.** Content-addressed originals, cached derivatives
pruned when no longer needed, a disk-space guard, and backups that hard-link
immutable photos so they take no extra space.

**Tested like it matters.** 188 unit and integration tests and 30 Playwright
browser tests. Platform APIs are exercised against loopback fakes that verify
what the app sends (including R2 request signatures), so the suite never touches a
real account. Security checks were mutation-tested: each was deliberately broken
to confirm a test fails.

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript 7 (strict), run directly by Node.js 26 type stripping |
| Server | Fastify 5, Zod 4 validation |
| Data | SQLite via better-sqlite3 (WAL, versioned checksummed migrations) |
| Images | sharp / libvips |
| UI | React 19, Vite 8, hand-written CSS |
| Platforms | Instagram Graph API (Instagram Login), Pinterest API v5, Cloudflare R2 |
| macOS | Keychain (`@napi-rs/keyring`), launchd LaunchAgent |
| Quality | Vitest, Playwright, oxlint, npm audit signatures |

## Project status

Feature-complete for single-photo posts and fully tested against simulated
platforms. **In progress:** first live posts (awaiting platform app approval),
multi-photo carousels, and Pinterest Standard API access.

## How it was built

Designed and directed by Madeleine Halle, with Claude Code as an AI pair
programmer for implementation. Product decisions, security requirements,
platform and infrastructure setup, and review were human-led.

---

## Running it locally

### Feature status

| Area | Status |
|---|---|
| Local server, sessions, CSRF, Host/Origin checks | ✅ Works |
| Migrations | ✅ Works |
| Data directories | ✅ Works |
| Built UI served from the same origin | ✅ Works |
| Accounts: create on either platform, rename, reorder, archive, restore | ✅ Works |
| Vertical account sidebar, per-account main panel, narrow-screen drawer | ✅ Works |
| Identity uniqueness and schedule-review rules | ✅ Works (enforced in the database; exercised by tests only, since connecting needs platform sign-in) |
| Photo library: multi-file upload, dedupe, thumbnails, safe deletion | ✅ Works |
| Single-photo drafts, platform-specific composer, crop with exact preview, validation | ✅ Works |
| Independent copies across accounts; deleting unpublished drafts | ✅ Works |
| Pinterest board selection | ⏳ Needs a connected account (milestone 6) |
| Scheduling with explicit time zones and daylight-saving handling | ✅ Works |
| Durable scheduler: leases, retries, missed-schedule policy, reconciliation, cancel | ✅ Works (tested against a simulated platform) |
| Publishing history, needs-attention handling, scheduler health, settings | ✅ Works |
| Platform setup (app IDs; secrets in the macOS Keychain) | ✅ Works |
| Connect / disconnect via OAuth with identity and eligibility checks | ✅ Works against test fakes; ⚠️ not yet tried with real Meta/Pinterest apps |
| Token storage and renewal | ✅ Works against test fakes; Keychain verified on this Mac |
| Pinterest publishing (direct upload, sandbox/standard) | ⚠️ Built and tested against fakes; no live Pin yet |
| Instagram publishing via R2 media delivery | ⚠️ Built and tested against fakes; no live post yet |
| R2 "Test connection" (upload, presigned read, delete) | ✅ Works against test fakes; run it in Platform setup to check your real bucket |
| Backups: daily, before upgrades, manual; verify, export, restore | ✅ Works (tested) |
| Background service (LaunchAgent) | ⚠️ Built and tested; not yet installed on this Mac |

More documentation:
- [Architecture decision](docs/adr/0001-architecture.md)
- [Security model](docs/security.md)
- [Scheduling and publishing](docs/scheduling.md)
- [Setting up real publishing](docs/setup-guide.md)

## Requirements

- macOS on Apple silicon
- Node.js 26.13.0 LTS (see `.node-version`)

If Node was installed per user under `~/.local/share/nodejs`, put it on your
`PATH` first:

```sh
export PATH="$HOME/.local/share/nodejs/current/bin:$PATH"
```

## Commands

```sh
npm ci              # install exact locked dependencies
npm run build       # build the web UI into dist/web
npm start           # start the server (production data directory, port 4870)
npm run open        # open the running app in your browser (signs this browser in)
npm run backup      # back up now (see "Backups" below)
npm run service -- install   # run in the background at login (see "Background service")

npm run typecheck   # strict TypeScript (server + web)
npm run lint        # oxlint
npm test            # Vitest; live publishing is always disabled in tests
npm run test:e2e    # build, then Playwright browser tests against throwaway data
npm run check       # typecheck + lint + unit tests
npm run audit:deps  # vulnerabilities, registry signatures/provenance, install scripts
npm run check:secrets # scan tracked files for credential-shaped strings
node scripts/keychain-probe.ts  # confirm the Keychain works for this app
```

The server runs TypeScript directly through Node's built-in type stripping, so
it has no separate server build step. Only the web UI is built.

### Development

Use two terminals:

```sh
npm run dev:web     # rebuild the UI on change
npm run dev         # restart the server on change (port 4871, data in .data/development)
npm run open -- --env development
```

To try the publishing flow without touching real platforms, start the
development server with simulated platforms, then connect an account to a
simulated identity:

```sh
MEDIA_MANAGER_FAKE_PLATFORMS=enabled npm run dev
node scripts/dev-fake-connect.ts --env development --account <account-id>
```

Simulated mode is refused in production and labelled everywhere in the UI.

Development and test data never use the real data directory. The config
refuses it.

## Data and secrets

- **Real data** lives in
  `~/Library/Application Support/AtelierHalleMediaManager`, outside this
  checkout. Override it with `MEDIA_MANAGER_DATA_DIR`, which must be an
  absolute path.
- **Port:** 4870 by default. Override it with `MEDIA_MANAGER_PORT`. The server
  only ever binds to `127.0.0.1`.
- **Platform credentials** live in the macOS Keychain. They never go in
  this repository, the database, or the browser.
- **Live publishing** is off unless `MEDIA_MANAGER_LIVE_PUBLISHING=enabled`,
  which is allowed in production only.
- Never commit secrets: `npm run check` includes a secret scan, and GitHub
  secret scanning with push protection should stay enabled on this repository.

## Backups

The server backs up automatically once a day (keeping 7) and just before any
database upgrade (keeping 3). Each backup is a consistent SQLite snapshot plus
the photo originals and thumbnails, **hard-linked**: they take no extra disk
space and still survive deleting the photo from the library. Secrets are never
in backups; they stay in the Keychain.

```sh
npm run backup                          # back up now (keeps the last 10 manual ones)
npm run backup -- list                  # newest first, with the extra space each uses
npm run backup -- verify <name>         # checksum, integrity check, every photo present
npm run backup -- export <name> /Volumes/MyDrive   # real copies, verified after copying
npm run backup -- restore <name or exported folder>
```

Backups sit on the same disk as the library, so they protect against
mistakes and a bad upgrade, not a failed disk: export to another drive, or let
Time Machine include `~/Library/Application Support/AtelierHalleMediaManager`.

**Restore** needs the app stopped. It verifies the backup, saves the current
state as a `pre-restore` backup first, and **pauses every account's schedules
until you review them**, so a post that the older data still lists as pending
can't be published a second time. Photos added after the backup are removed
from the library on the next start (they remain in the `pre-restore` backup).

## Background service

```sh
npm run service -- install          # start at login, restart after a crash (live publishing off)
npm run service -- install --live   # the same, with live publishing on
npm run service -- status           # running? responding? Keychain usable?
npm run service -- stop             # stop until next login (or `start`)
npm run service -- uninstall        # remove; data is untouched
```

It installs `~/Library/LaunchAgents/com.atelierhalle.media-manager.plist`,
which runs the server directly (no shell) with the current Node binary pinned.
Run `install` again after upgrading Node or moving this folder. Output goes to
`logs/service.log` in the data directory, rotated at 10 MB. Stop a Terminal
`npm start` first; only one server can use the data directory.

### Browser tests

Playwright uses its own Chromium build. Install it once with
`npx playwright install chromium`. It goes into
`~/Library/Caches/ms-playwright`. Each test starts the real server on its own
temporary data directory.

## Photos

- **Accepted:** JPEG, PNG and WebP, up to 50 MB and 100 megapixels each.
- **HEIC (iPhone default):** not supported yet. In Photos, choose
  File › Export › Export 1 Photo, set Kind to JPEG, and upload that file.
- **Originals:** uploads are copied into the app's data directory. Originals
  are kept unchanged, including any location data. Everything sent to
  Instagram or Pinterest is a separate copy with all metadata removed. See
  [docs/security.md](docs/security.md#photo-handling).
