# 🧭 Binnacle

A dead-simple **tree wiki**. Pages form an Obsidian-style nested tree; every page is
raw HTML. You manage it entirely through an **MCP** (from any device via Claude), and
read it on the web. One Cloudflare Worker + D1. No heavy interface, no Confluence.

- **Write** → MCP tools (`create_page`, `update_page`, `move_page`, …)
- **Read** → private web view (Phase 2)
- **Auth** → one bearer token, stored once in your password manager

## Status

- ✅ **Phase 1** — MCP server + D1 schema
- ✅ **Phase 2** — web reader (`/login` cookie + rendered tree, breadcrumbs, light/dark)
- ✅ **Phase 4** — full-text search (FTS5): sidebar box, `/search`, `search` MCP tool
- ✅ **Phase 3** — revision history + diff view (`?history`/`?v`/`?diff`) + `/activity` feed
- ✅ **OAuth** — self-contained OAuth 2.1 server so the Claude mobile app / claude.ai can
  connect as a Connector; login credential is `AUTH_TOKEN`. Claude Code still uses the raw
  bearer token via header.
- ⬜ Polish — manual sort ordering, backup mirror

### Connecting clients

- **Claude Code (desktop):** `claude mcp add --scope user --transport http binnacle
  https://binnacle.dort.zone/mcp --header "Authorization: Bearer <AUTH_TOKEN>"`
- **Claude mobile app / claude.ai:** add a custom connector for `https://binnacle.dort.zone/mcp`.
  It runs the OAuth flow → a Binnacle login page → paste your `AUTH_TOKEN` → connected.

### Routes

Reader: `/` · `/<path>` · `/<path>?history=1` · `?v=N` · `?diff=N` · `/search?q=` · `/activity`
· `/login` · `/logout`.
OAuth: `/.well-known/oauth-authorization-server` · `/.well-known/oauth-protected-resource`
· `/register` · `/authorize` · `/token`.
Reserved top-level slugs (shadowed by routes): `mcp`, `health`, `login`, `logout`, `search`,
`activity`, `authorize`, `token`, `register`.

## One-time setup

```bash
# 1. Create the D1 database, then paste the returned id into wrangler.toml
npm run db:create

# 2. Apply the schema (remote = the deployed DB)
npm run db:migrate

# 3. Set your single secret token (used by MCP now, the reader later)
npm run secret:token      # paste a long random string; save it in your password manager
```

Deployment mirrors the Wizzard repo: **push to `main` and Cloudflare Workers Builds
auto-deploys** (connect the repo once in the Cloudflare dashboard → Workers & Pages →
Create → connect to Git). CLI fallback: `npx wrangler@latest deploy`.

## Connect the MCP

The server speaks MCP over Streamable HTTP at `POST /mcp`, bearer-gated. In Claude Code:

```bash
claude mcp add --transport http binnacle https://binnacle.<subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Clients that can't set a custom header can instead use `?token=YOUR_TOKEN` on the URL
(less tidy; fine to start). If the phone/web app ends up needing OAuth, that's a small
later addition.

## MCP tools

| Tool | What it does |
|---|---|
| `list_tree` | compact nested tree (`root?`, `depth?`) |
| `get_page` | full page by `id` or `path` |
| `create_page` | new page (`title`, optional `parent_id`, `slug`, `content_html`) |
| `update_page` | edit `title`/`content_html`; snapshots prior version |
| `move_page` | reparent/reorder; subtree moves with it |
| `delete_page` | delete (`recursive` for subtrees) |
| `list_revisions` | history for a page |
| `restore_revision` | roll a page back to a version |

## Data model

`pages(id, parent_id, slug, title, content_html, sort_order, version, …)` — the
`parent_id` self-reference *is* the tree. `revisions` keeps the last 20 snapshots per
page (full HTML, no diffs). See `migrations/0001_init.sql`.
