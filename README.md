# Atelier Halle Media Manager

A private, single-user, local-first tool for preparing and scheduling photo
posts to Instagram and Pinterest from macOS, without opening the social apps.

**Status: milestone 6 (sign-in, Keychain, real adapters; not yet verified live).**

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
- Keep this repository private and turn on GitHub secret scanning. A private
  repository is still not a place to store secrets.

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
