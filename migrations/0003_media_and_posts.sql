-- Immutable originals, content-addressed. Files live under the media directory;
-- paths here are relative to it and are never taken from user input.
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('jpeg', 'png', 'webp')),
  original_path TEXT NOT NULL,
  thumb_path TEXT NOT NULL,
  original_filename TEXT,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  -- Display dimensions after applying EXIF orientation.
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  has_location INTEGER NOT NULL CHECK (has_location IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

-- One destination post per account. Copies are independent rows.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'scheduled', 'preparing', 'publishing', 'published', 'retry_waiting', 'needs_attention', 'canceled'
  )),
  -- Instagram
  caption TEXT NOT NULL DEFAULT '',
  -- Both platforms
  alt_text TEXT NOT NULL DEFAULT '',
  -- Pinterest
  pin_title TEXT NOT NULL DEFAULT '',
  pin_description TEXT NOT NULL DEFAULT '',
  pin_link TEXT NOT NULL DEFAULT '',
  pin_board_id TEXT,
  pin_board_name TEXT,
  copied_from_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX posts_by_account ON posts (account_id, status, updated_at);

-- Ordered photos for a post, with an explicit, previewed crop.
CREATE TABLE post_media (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  crop_aspect TEXT NOT NULL CHECK (crop_aspect IN ('original', '1:1', '4:5', '1.91:1', '2:3')),
  crop_focus_x REAL NOT NULL DEFAULT 0.5 CHECK (crop_focus_x BETWEEN 0 AND 1),
  crop_focus_y REAL NOT NULL DEFAULT 0.5 CHECK (crop_focus_y BETWEEN 0 AND 1),
  PRIMARY KEY (post_id, position)
) STRICT;

CREATE INDEX post_media_by_asset ON post_media (media_asset_id);
