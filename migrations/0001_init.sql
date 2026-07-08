-- Binnacle initial schema.
-- Every node lives in `pages`; the tree is the parent_id self-reference.
-- A node may hold BOTH content and children (Confluence-style, not strict leaf-only).

CREATE TABLE pages (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT,                              -- NULL = top-level (root) page
  slug         TEXT NOT NULL,                     -- url segment, unique among siblings
  title        TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',          -- raw HTML body fragment
  sort_order   INTEGER NOT NULL DEFAULT 0,        -- manual ordering within a parent
  version      INTEGER NOT NULL DEFAULT 1,        -- current version; bumped on each update
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_pages_parent ON pages(parent_id, sort_order);

-- Snapshot-on-update history. On every edit the PREVIOUS state is copied here.
-- We keep the last N per page (pruned in the worker); full snapshots, no diffs.
CREATE TABLE revisions (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL,
  version      INTEGER NOT NULL,                  -- the version number of this snapshot
  title        TEXT NOT NULL,
  content_html TEXT NOT NULL,
  summary      TEXT,                              -- change note for the edit that superseded it
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_revisions_page ON revisions(page_id, version DESC);
