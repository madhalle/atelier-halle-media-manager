# ADR 0001: Local-first architecture

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

This is a private, single-user, macOS-local tool for preparing and scheduling
photo posts to several Instagram and Pinterest accounts. It has to keep
working (drafting, planning, scheduling) while platform access is still being
set up. It must also stay cheap to run and easy to understand.

At the start, the repository was **empty**. There was no earlier scaffold, no
hardcoded account slots, and no user data. So no legacy-account migration is
needed now. If a scaffold with fixed slots turns up later, the migration rules
in the plan still apply. The machine had no Node.js and no Homebrew.

## Decision

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js **26.13.0 LTS** ("Lithium", LTS since 2026-10-28), darwin-arm64 | Pinned in `.node-version` and `engines`. Installed per user from the checksum-verified nodejs.org tarball into `~/.local/share/nodejs/current`. No root needed. |
| Package manager | **npm 11** with committed `package-lock.json` | Node 26 no longer ships Corepack, so npm avoids extra tooling. Exact versions are pinned. npm `allowScripts` denies dependency install scripts by default. |
| Language | TypeScript 7 (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`) | The server runs as `.ts` through Node 26's built-in type stripping, so it has no server build step. `tsc` only type-checks. |
| Lint | oxlint | `typescript-eslint` does not support TypeScript 7 yet (its peer range is `<6.1`). oxlint has no TypeScript peer dependency. |
| HTTP | Fastify 5 | One process serves the built UI and the API from one loopback origin. |
| Validation | Zod 4 | Validates requests, config, and provider responses at runtime. |
| Database | SQLite via **better-sqlite3 13** | Ships darwin-arm64 prebuilds, so it doesn't need `node-gyp` or Xcode. It has a synchronous transaction API and online `backup()`. `node:sqlite` was rejected for now because on Node 26 it is still "1.2 Release candidate" and its API is still changing (`DatabaseSync` → `Database`). |
| Images | sharp 0.35 (libvips 8.18) | It handles orientation, sRGB conversion, metadata stripping, and pixel limits (all covered by tests). **The prebuilt libvips can't decode HEIC.** HEIC uploads are rejected with guidance for now. Converting through macOS `sips` could be added later as a separate, tested option. |
| Credentials | macOS Keychain via `@napi-rs/keyring` | Native N-API binding. It avoids `/usr/bin/security`, which would put secrets in process arguments. Background Keychain access gets verified in milestone 6. |
| UI | React + Vite (added in milestone 3) | Vite is used for development and builds only. Production is served by Fastify. |
| Tests | Vitest; Playwright for a few flows (added later) | Fake clock and fake providers. Live publishing is disabled in tests through `MEDIA_MANAGER_LIVE_PUBLISHING=disabled`. |

**Process model:** one backend process. The scheduler polls SQLite about once
a minute, claims due work with leases, and processes one publication at a
time. The browser is only a client.

**Layout:**

```
src/domain      platform-independent rules: states, transitions, validation, time
src/storage     SQLite repositories, migrations runner, media store, backups
src/platforms   instagram/, pinterest/, fake/ adapters behind one small interface
src/server      Fastify app, sessions, CSRF, Host/Origin checks, routes
src/web         React UI
migrations      versioned .sql files
tests           vitest (unit/integration) and playwright (e2e)
docs            ADRs, capability matrix, operations
```

**Data directory:** the default is
`~/Library/Application Support/AtelierHalleMediaManager`, overridable with
`MEDIA_MANAGER_DATA_DIR`. Development and tests use separate directories that
are explicitly set and gitignored. Directories get mode `0700` and files
`0600`.

**Network:** the app binds to `127.0.0.1` only. It uses an exact Host/Origin
allowlist, no CORS, and a session cookie obtained by exchanging a single-use
launch token.

## Consequences

- Instagram can't publish from a purely local setup, because Meta fetches
  images from a public URL (see `docs/platform-capabilities.md`). That needs
  a narrowly scoped, explicitly authorized media-staging adapter (milestone
  7). Until then, due Instagram posts move to "needs attention" and are never
  reported as published.
- Pinterest needs no public infrastructure, but public Pins need Standard API
  access.
- Native modules (better-sqlite3, sharp, keyring) tie the server to Node and
  macOS. Domain logic stays free of them so a future cloud or desktop version
  can reuse it.
- The local database isn't separately encrypted. Data at rest relies on
  FileVault and encrypted system backups.
- **Trust boundary:** the app doesn't protect against a compromised OS or
  another process running as the same macOS user.
