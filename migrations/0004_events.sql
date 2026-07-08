-- Timestamped events emitted by interactive artifacts (checkboxes, status
-- cycles, counters, notes). One generic primitive: {key, value, label}.
-- Current state of a page = the latest event per key. The full row set is the
-- history — a timestamped log an agent can read instead of guessing at state.

CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL,
  key        TEXT NOT NULL,               -- control id within the page
  value      TEXT NOT NULL,               -- JSON-encoded (bool / number / string)
  label      TEXT,                        -- human label for the timeline
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_events_page ON events(page_id, created_at);
