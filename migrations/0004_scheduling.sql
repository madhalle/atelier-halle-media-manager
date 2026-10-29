-- Durable scheduling. SQLite is the source of truth; the scheduler polls it.
-- scheduled_at and next_attempt_at are UTC ISO-8601 instants. local_time and
-- timezone record what the user chose so schedules never move silently.
ALTER TABLE posts ADD COLUMN scheduled_at TEXT;
ALTER TABLE posts ADD COLUMN timezone TEXT;
ALTER TABLE posts ADD COLUMN local_time TEXT;
ALTER TABLE posts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN next_attempt_at TEXT;
-- Expiring lease held by the worker processing this post.
ALTER TABLE posts ADD COLUMN claim_token TEXT;
ALTER TABLE posts ADD COLUMN claim_expires_at TEXT;
ALTER TABLE posts ADD COLUMN claimed_revision INTEGER;
ALTER TABLE posts ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1));
-- Set immediately before the irreversible platform call. Once set, the post is
-- never blindly re-published: an interrupted or uncertain call is reconciled.
ALTER TABLE posts ADD COLUMN commit_started_at TEXT;
ALTER TABLE posts ADD COLUMN reconcile_required INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_required IN (0, 1));
ALTER TABLE posts ADD COLUMN remote_container_id TEXT;
ALTER TABLE posts ADD COLUMN remote_post_id TEXT;
ALTER TABLE posts ADD COLUMN remote_permalink TEXT;
ALTER TABLE posts ADD COLUMN published_at TEXT;
ALTER TABLE posts ADD COLUMN published_simulated INTEGER NOT NULL DEFAULT 0 CHECK (published_simulated IN (0, 1));
ALTER TABLE posts ADD COLUMN attention_kind TEXT CHECK (attention_kind IN (
  'not_connected', 'not_configured', 'missed', 'validation', 'permanent', 'auth', 'retries_exhausted', 'ambiguous'
));
ALTER TABLE posts ADD COLUMN attention_message TEXT;

CREATE INDEX posts_due ON posts (status, next_attempt_at);

-- One row per processing attempt. Holds sanitized error details only.
CREATE TABLE publish_attempts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('preflight', 'stage', 'check', 'commit', 'reconcile')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'in_progress', 'published', 'retry', 'pending', 'rate_limited', 'auth_expired', 'permanent',
    'ambiguous', 'not_published', 'skipped', 'canceled', 'paused', 'interrupted'
  )),
  error_code TEXT,
  error_message TEXT,
  remote_container_id TEXT,
  remote_post_id TEXT,
  media_asset_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
  derivative_sha256 TEXT,
  post_revision INTEGER NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0, 1))
) STRICT;

CREATE INDEX publish_attempts_by_post ON publish_attempts (post_id, attempt_no);

CREATE TABLE scheduler_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL,
  last_tick_at TEXT,
  last_tick_error TEXT,
  interval_ms INTEGER NOT NULL
) STRICT;
