# Scheduling and publishing

The backend owns scheduling. Closing the browser doesn't stop scheduled work
while the server process is running.

## How it runs

- **Polling:** the server reads SQLite about once a minute
  (`MEDIA_MANAGER_SCHEDULER_INTERVAL_MS`). There are no per-post timers, so
  restarts lose nothing. Posts go out within roughly a minute of their time,
  not to the second.
- **One at a time:** each tick processes up to 10 due posts in sequence.
- **Leases:** a post is taken with an atomic `UPDATE … RETURNING` that sets a
  random claim token and a 5-minute expiry. Every later write by the worker is
  conditioned on that token, so a worker whose lease expired can't overwrite
  newer state.

## States

`draft → scheduled → preparing → publishing → published`, plus
`retry_waiting`, `needs_attention` and `canceled`. The allowed transitions
are in `src/domain/publishing.ts`.

| Status | Content editable | Notes |
|---|---|---|
| draft, canceled | yes | Can be deleted if never sent. |
| scheduled, retry_waiting | yes | Edits bump the revision, which is rechecked before publishing. |
| preparing, publishing | **no** | Platform calls may be in flight. |
| needs_attention | yes, except uncertain outcomes | |
| published | no | |

## Safety argument

Publishing is split into steps:

1. **Preflight.** Is the platform integration configured? Was the scheduled
   time missed? Does the post still pass validation? Do credentials exist?
   Then the exact derivative is prepared and its SHA-256 recorded.
2. **Stage.** Repeatable, nothing is public yet. For Instagram this creates a
   media container, and the container ID is **persisted immediately** so a
   retry reuses it.
3. **Check.** Repeatable. If the platform is still processing, the post is
   checked again in a minute.
4. **Final recheck**, immediately before the irreversible call: is the lease
   still held, was a cancel requested, did the revision change, is the
   account still connected, unarchived and not under review?
5. **Persist `commit_started_at`**, then make the irreversible publish call.
6. **Persist the result.**

**Once step 5 has started, the post is never sent again** unless the platform
confirms it wasn't published:

- **A definitive refusal** (`permanent`, `auth_expired`, `rate_limited`)
  means nothing was published. The commit marker is cleared and the normal
  rules apply.
- **Anything else** (timeout, dropped connection, 5xx, crash) leads to
  reconciliation, using the saved identifiers:
  - **published:** recorded as published.
  - **not_published:** retried with a fresh container.
  - **unknown:** `needs_attention` (`ambiguous`). The user checks the
    platform and answers "it was published" or "it wasn't". Until then the
    content is locked and nothing is retried.
- **A crash after step 5:** the expired lease is recovered with
  `reconcile_required`. The next run reconciles; it doesn't re-send.

Exactly-once delivery across an external API can't be guaranteed. The app
guarantees it never *blindly* repeats a publish that may have succeeded.

## Failures

| Kind | Behaviour |
|---|---|
| transient | Retry with exponential backoff and jitter: 30–60 s, then doubling, up to 1 h. Gives up after 6 attempts and needs attention. |
| rate_limited | Honours the provider's Retry-After (up to 24 h) when it's longer than the backoff. |
| auth_expired | Needs attention. The account is marked "reconnect needed". |
| permanent | Needs attention, with the platform's (sanitized) reason. No retries. |
| ambiguous | Reconciled, as described above. |
| unexpected local error | Logged in full on the server only. Stored as a generic message and retried. |

Attempt records hold sanitized messages and codes only, never tokens, signed
URLs or raw provider payloads. A test checks this.

## Accounts

| Account state when a post is due | Result |
|---|---|
| Never connected | `needs_attention`: "Not published: this account isn't connected…". Nothing is sent and success is never simulated. |
| Archived, disconnected, reconnect needed, or schedules under review | **Paused.** The post stays scheduled and nothing is sent. Restoring, connecting or reconnecting always requires "Mark schedules reviewed" before anything resumes. |
| Publishing to that platform isn't set up in this build | `needs_attention` (`not_configured`). |

## Missed schedules

- Work that hasn't started and is at most **30 minutes** late (configurable
  in Settings, 0–1440) publishes automatically. Older work becomes
  `needs_attention` (`missed`) for review.
- Retries and reconciliation of work that already started aren't "missed".
  They follow the rules above.
- Missed work is detected on the first tick after startup or wake. The
  scheduler also logs when it resumes after a gap.

## Time zones

- Each schedule stores the wall-clock time and IANA zone the user chose
  (default `America/New_York`), plus the resulting UTC instant. Changing the
  Mac's time zone or travelling doesn't move existing schedules.
- Times are resolved on the server with `Temporal`:
  - **Nonexistent times** (spring forward) are rejected with the next valid
    time suggested.
  - **Ambiguous times** (fall back) require choosing the first or second
    occurrence.
  - Nothing is shifted silently.

## What can prevent publishing

- **The server isn't running:** the Mac is asleep or shut down, the user is
  logged out, or the app was quit. The app doesn't change sleep settings.
- **No internet connection.**
- **Platform credentials are unavailable** (Keychain locked or access
  denied, from milestone 6). Affected work pauses with a message.

The sidebar shows whether the scheduler is running, when it last checked, and
counts of scheduled, overdue and needs-attention posts. A banner appears when
the scheduler hasn't checked in recently. Failures stay visible in the app
whether or not notifications are on.

## Simulated publishing (development and tests only)

Setting `MEDIA_MANAGER_FAKE_PLATFORMS=enabled` replaces the platforms with a
deterministic fake (`src/platforms/fake.ts`).

- **Production refuses to start** with this setting, and it's mutually
  exclusive with live publishing.
- **Labelling:** a banner is shown, results are marked "simulated", and
  nothing leaves the machine.
- **Fake identities:** `scripts/dev-fake-connect.ts` connects an account to a
  simulated identity, in development or test data only.
- **Scripting in tests:** markers in the caption select fake behaviours:
  `[fake:permanent]`, `[fake:transient]`, `[fake:auth]`, `[fake:lost]`,
  `[fake:ambiguous]` and `[fake:unknown]`.
