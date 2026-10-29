-- User-defined account tabs. A fresh install has no rows.
-- "Personal"/"Business" are display-name labels only, never integration types.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'pinterest')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  sort_order INTEGER NOT NULL,
  archived_at TEXT,
  connection_state TEXT NOT NULL DEFAULT 'unconnected'
    CHECK (connection_state IN ('unconnected', 'connected', 'needs_reconnect', 'disconnected')),
  -- Verified provider identity; set only after a real platform check.
  provider_account_id TEXT,
  provider_username TEXT,
  provider_display_name TEXT,
  provider_avatar_url TEXT,
  provider_account_type TEXT,
  identity_verified_at TEXT,
  -- Opaque Keychain reference; never a secret.
  credential_ref TEXT,
  -- Set when archiving, disconnecting, restoring or reconnecting so that old
  -- schedules never resume silently.
  schedules_need_review INTEGER NOT NULL DEFAULT 0 CHECK (schedules_need_review IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (connection_state <> 'connected' OR (provider_account_id IS NOT NULL AND credential_ref IS NOT NULL))
) STRICT;

CREATE INDEX accounts_active_order ON accounts (sort_order) WHERE archived_at IS NULL;

-- One platform identity may back at most one active connected tab.
CREATE UNIQUE INDEX accounts_unique_active_identity
  ON accounts (platform, provider_account_id)
  WHERE provider_account_id IS NOT NULL
    AND archived_at IS NULL
    AND connection_state IN ('connected', 'needs_reconnect');
