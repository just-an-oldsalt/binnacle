-- Full-text search over pages.
-- Standalone FTS5 table maintained by the worker (not triggers): on every
-- create/update/delete the worker writes the page's title + tag-stripped body
-- here, so snippets are clean plaintext. page_id maps a hit back to pages.

CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  body,
  page_id UNINDEXED,
  tokenize = 'porter unicode61'
);

-- Backfill any pages that already exist (body still has tags for these until
-- their next edit refreshes it; new/edited pages get stripped plaintext).
INSERT INTO pages_fts (page_id, title, body)
SELECT id, title, content_html FROM pages;
