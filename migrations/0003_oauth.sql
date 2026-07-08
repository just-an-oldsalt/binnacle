-- OAuth 2.1 authorization-server state.
-- Access/refresh tokens are self-verifying HMACs (no storage). We only persist
-- registered clients (from Dynamic Client Registration) and short-lived,
-- one-time authorization codes.

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,               -- JSON array
  client_name   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,               -- PKCE S256 challenge
  expires_at     INTEGER NOT NULL             -- epoch ms
);
