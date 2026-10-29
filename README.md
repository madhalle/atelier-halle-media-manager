# Atelier Halle Media Manager

A private, single-user, local-first tool for preparing and scheduling photo
posts to Instagram and Pinterest from macOS, without opening the social apps.

**Status: milestone 2 (secure local foundation).**

| Area | Status |
|---|---|
| Local server, sessions, CSRF, Host/Origin checks | ✅ Works |
| Migrations | ✅ Works |
| Data directories | ✅ Works |
| Built UI served from the same origin | ✅ Works |
| Accounts, gallery, uploads, scheduling | ⏳ Not built yet (milestones 3–5) |
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
npm run check       # all three
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
