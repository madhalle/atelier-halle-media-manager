# Atelier Halle Media Manager

A private, single-user, local-first tool for preparing and scheduling photo
posts to Instagram and Pinterest from macOS, without opening the social apps.

**Status: milestone 4 (photos, composer, copies).**

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
| Scheduling, publishing history | ⏳ Not built yet (milestone 5) |
| Connect / disconnect a real platform account | ⏳ Not built yet (milestone 6) |
| Instagram / Pinterest publishing | ❌ Not built and not tested live; see [capabilities](docs/platform-capabilities.md) |

More documentation:
- [Architecture decision](docs/adr/0001-architecture.md)
- [Security model](docs/security.md)

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

npm run typecheck   # strict TypeScript (server + web)
npm run lint        # oxlint
npm test            # Vitest; live publishing is always disabled in tests
npm run test:e2e    # build, then Playwright browser tests against throwaway data
npm run check       # typecheck + lint + unit tests
npm run audit:deps  # vulnerabilities, registry signatures/provenance, install scripts
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

Development and test data never use the real data directory. The config
refuses it.

## Data and secrets

- **Real data** lives in
  `~/Library/Application Support/AtelierHalleMediaManager`, outside this
  checkout. Override it with `MEDIA_MANAGER_DATA_DIR`, which must be an
  absolute path.
- **Port:** 4870 by default. Override it with `MEDIA_MANAGER_PORT`. The server
  only ever binds to `127.0.0.1`.
- **Platform credentials** will live in the macOS Keychain. They never go in
  this repository, the database, or the browser.
- **Live publishing** is off unless `MEDIA_MANAGER_LIVE_PUBLISHING=enabled`,
  which is allowed in production only.
- Keep this repository private and turn on GitHub secret scanning. A private
  repository is still not a place to store secrets.

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
