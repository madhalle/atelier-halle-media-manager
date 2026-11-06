-- An account being added through "Add account" stays hidden until its first
-- successful connection, so the sidebar only ever shows real, connected tabs.
-- Existing accounts are complete.
ALTER TABLE accounts ADD COLUMN setup_pending INTEGER NOT NULL DEFAULT 0 CHECK (setup_pending IN (0, 1));
