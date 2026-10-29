# Atelier Halle Media Manager

A private, single-user, local-first tool for preparing and scheduling photo
posts to Instagram and Pinterest from macOS, without opening the social apps.

**Status: milestone 1 (feasibility and foundations).** Nothing runs yet beyond
the dependency compatibility tests. No platform integration has been tested
live. See [docs/platform-capabilities.md](docs/platform-capabilities.md) and
[docs/adr/0001-architecture.md](docs/adr/0001-architecture.md).

## Requirements

- macOS on Apple silicon
- Node.js 26.13.0 LTS (see `.node-version`)

If Node isn't on your `PATH` and was installed per user under
`~/.local/share/nodejs`:

```sh
export PATH="$HOME/.local/share/nodejs/current/bin:$PATH"
```

## Commands

```sh
npm ci              # install exact locked dependencies
npm run typecheck   # strict TypeScript check
npm test            # Vitest (live publishing is always disabled in tests)
```

Development, build, production start, lint, backup, and restore commands are
added in later milestones as they start working.

## Data and secrets

- Application data defaults to
  `~/Library/Application Support/AtelierHalleMediaManager`, outside this
  checkout.
- Platform credentials will live in the macOS Keychain, never in the
  repository, the database, or the browser.
- Keep this repository private and turn on GitHub secret scanning. A private
  repository is still not a place to store secrets.
