<div align="center">

# 🧭 Binnacle

**A personal wiki that Claude writes for you — and that actually _runs_.**

Talk to Claude; it builds you a tree of bespoke, interactive HTML pages. Read them on the
web from any device. The whole thing is one Cloudflare Worker and one SQLite database, and
it fits inside Cloudflare's free tier.

[![License: MIT](https://img.shields.io/badge/License-MIT-e8ff00.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-5A67D8)](https://modelcontextprotocol.io/)
[![Runs free](https://img.shields.io/badge/hosting-free%20tier-4cff91.svg)](#-it-runs-on-the-free-tier)

</div>

<!--
  MAINTAINER: drop a screen recording here — it sells the whole thing in five seconds.
  Show: "Claude, add a page tracking my Germany trip" → a rich page appears → tick a
  checkbox in the reader → ask Claude "what did I check off?" and it reads the log back.
  ![Binnacle demo](docs/demo.gif)
-->

---

## What it is

Binnacle is a **tree wiki**: an Obsidian-style nested tree of pages where **every page is
raw HTML you never have to write**. You manage the whole thing by talking to Claude over
**MCP** — "start a page for the kitchen reno", "add a budget table", "tick off the permit" —
and you read it in a fast, private web reader with search, breadcrumbs, revision history,
and an activity feed.

There is no block editor, no template picker, no per-seat billing, and no Docker-compose
full of services. There is one file (`worker.ts`), one database (Cloudflare D1 / SQLite),
and one access token.

- **Write** → Claude, via MCP tools (`create_page`, `update_page`, `search`, …)
- **Read** → a private, server-rendered web reader (tree nav, search, history, diffs)
- **Own** → your Cloudflare account, your data, revisioned and exportable — no lock-in

---

## Why not just use Notion / Confluence / Obsidian / a folder of Markdown?

Because those force a trade you shouldn't have to make. A folder of Markdown is yours but
inert. Notion is rich but a walled garden you rent. Confluence is powerful but a server farm
to run. Binnacle's bet: **let an AI author the pages, let the pages be real web artifacts,
and keep the whole thing small enough that you own it outright.**

|                              | **🧭 Binnacle** | Notion / Confluence | Obsidian | Folder of Markdown |
|------------------------------|:---:|:---:|:---:|:---:|
| **Authoring**                | Talk to Claude — it writes the page | Manual blocks / WYSIWYG | Manual Markdown | Manual Markdown |
| **A page can be…**           | Any HTML/CSS/JS artifact — dashboards, trackers, charts | Fixed block types | Text + plugins | Text |
| **Interactive & stateful**   | ✅ live controls, synced server-side | Limited (DBs) | Plugins only | ❌ |
| **First-class AI access**    | ✅ it's an MCP server — read & write | Bolt-on integrations | ❌ | Only if you script it |
| **Read on any device**       | ✅ web reader + mobile connector | ✅ | Sync app | Whatever renders it |
| **You host & own it**        | ✅ your Cloudflare account | ❌ rented | ✅ local files | ✅ local files |
| **Ops to run it**            | 1 Worker + 1 SQLite | SaaS or a server farm | Desktop app | None |
| **Cost**                     | **$0 on the free tier** | Per-seat subscription | Free / paid sync | Free |
| **Full-text search**         | ✅ FTS5, built in | ✅ | ✅ | Grep |
| **Revision history & diffs** | ✅ per page | ✅ | Via git | Via git |

The point isn't that Binnacle beats all of them at everything — Obsidian is unbeatable
offline, Notion has a decade of polish. It's that Binnacle occupies a spot **none of them
do**: an AI-authored, self-hosted, genuinely-interactive knowledge base that costs nothing
to run and that you can read end-to-end in an afternoon.

### The thing the others can't do: pages that are alive

Ask Claude for a trip checklist and you don't get a bulleted list — you get a page with
**real checkboxes that remember what you ticked**, on every device, with a timestamped log
Claude can read back later:

```js
// Injected into every page. No localStorage needed — state is synced to your D1.
cb.checked = !!bnc.state['buy-tickets'];               // restored on load, across devices
cb.onchange = () => bnc.log('buy-tickets', cb.checked, // written to the server, timestamped
                            'Buy Neuschwanstein tickets');
```

Tick it on your phone; ask Claude on your laptop *"what's left on the Germany trip?"* — it
calls `get_events`, reads the log, and tells you. Checkboxes, status pills, counters, notes:
one primitive, fully synced, fully auditable. That loop — **an agent that both writes the
page and reads what you did on it** — is the whole reason Binnacle exists.

---

## 💸 It runs on the free tier

Binnacle is built to cost nothing for personal use. It's a single Worker backed by D1;
there's no container, no Postgres, no Redis, nothing idling. A personal wiki won't come
close to Cloudflare's free-plan limits (at the time of writing: **100k Worker requests/day**,
and D1's **5 GB storage / 5M row-reads a day / 100k row-writes a day** — [check current
limits](https://developers.cloudflare.com/workers/platform/limits/)).

You need a (free) Cloudflare account. That's the only bill, and for one person it's $0.

---

## 🚀 Quickstart (about 5 minutes)

**Prerequisites:** [Node.js](https://nodejs.org/) 18+ and a free
[Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
git clone https://github.com/just-an-oldsalt/binnacle.git
cd binnacle
npm install
npm run setup
```

`npm run setup` does everything: logs you into Cloudflare (opens a browser if needed),
creates the D1 database and writes its id into `wrangler.toml`, applies the schema, deploys
the Worker, generates a strong access token and stores it as a secret — then prints your URL
and token.

When it finishes you'll have a live wiki at `https://binnacle.<your-subdomain>.workers.dev`.
**Save the printed token in your password manager** — it's shown only once, and it's the
single credential for both the MCP and the web reader.

Open the URL, log in with that token, and (optionally) seed a starter tree so it isn't empty:

```bash
BINNACLE_URL=https://binnacle.<your-subdomain>.workers.dev \
BINNACLE_TOKEN=<your-token> npm run seed
```

> Prefer to wire it up by hand, or curious what the script does? See
> [Manual setup](#manual-setup) below.

### Deploying updates

`npm run deploy` pushes the current code. Or connect the repo once in the Cloudflare
dashboard (**Workers & Pages → Create → connect to Git**) and every push to `main`
auto-deploys.

---

## 🔌 Connect Claude

Binnacle speaks MCP over Streamable HTTP at `POST /mcp`, gated by your token.

**Claude Code (desktop):**

```bash
claude mcp add --scope user --transport http binnacle \
  https://binnacle.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <your-token>"
```

**Claude mobile app / claude.ai:** add a **custom connector** pointing at
`https://binnacle.<your-subdomain>.workers.dev/mcp`. Binnacle ships a self-contained
OAuth 2.1 server, so the app runs the standard connect flow → shows a Binnacle authorize
page → you paste your token once → connected. (Clients that can't send a header can also use
`?token=<your-token>` on the URL, though a header is tidier.)

Now just talk to it: *"Make a page under Projects for the deck rebuild, with a materials
table and a checklist for the permit steps."*

---

## 🛠️ MCP tools

| Tool | What it does |
|---|---|
| `list_tree` | Compact nested tree of the whole wiki (`root?`, `depth?`) |
| `get_page` | Full page HTML by `id` or `path` (e.g. `/projects/deck`) |
| `create_page` | New page (`title`, optional `parent_id`, `slug`, `content_html`) |
| `update_page` | Edit `title`/`content_html`; snapshots the prior version first |
| `move_page` | Reparent / reorder; the whole subtree moves with it |
| `delete_page` | Delete a page (`recursive: true` for a subtree) |
| `search` | Full-text search over titles + body (FTS5); returns paths + snippets |
| `list_revisions` | A page's saved versions, newest first |
| `restore_revision` | Roll a page back to a version (snapshots current first) |
| `get_events` | Read the timestamped interaction log (checkboxes, statuses, notes) |

Each page's `content_html` can be a **complete HTML document** (renders isolated as a
bespoke artifact with its own fonts, styles, and scripts) **or** a plain fragment that
inherits the reader's theme. Rich, interactive pages use the full-document form.

---

## 🧩 How it works

```
        Claude (Code / mobile / web)
                  │  MCP over HTTPS (bearer or OAuth)
                  ▼
        ┌───────────────────────┐
        │   Cloudflare Worker   │   worker.ts — one file, ~1.8k lines, no framework
        │  ┌─────────────────┐  │     • /mcp        JSON-RPC tool server
        │  │  MCP  ·  Reader  │  │     • reader      server-rendered tree + search + history
        │  │  OAuth · Search  │  │     • /authorize  self-contained OAuth 2.1 for connectors
        │  └─────────────────┘  │
        └───────────┬───────────┘
                    │  SQL
                    ▼
        ┌───────────────────────┐
        │   Cloudflare D1        │   pages · revisions · pages_fts · events · oauth_*
        │   (SQLite)             │
        └───────────────────────┘
```

- **The tree is one self-referential table.** `pages(parent_id …)` *is* the hierarchy; a
  page can hold both content and children.
- **History is snapshot-on-write.** Every edit copies the previous state into `revisions`
  (last 20 per page kept), powering `?history`, `?v=N`, and `?diff=N` in the reader.
- **Interactive pages are isolated.** A full-document page renders in a sandboxed iframe, so
  its CSS/JS can't touch the reader or other pages. State goes through the injected
  `window.bnc` API to your D1 (not `localStorage`, which the sandbox blocks) and is logged
  to the `events` table.
- **Search is FTS5**, maintained by the Worker so snippets are clean plaintext.

### Security model

One `AUTH_TOKEN` is the whole trust boundary. It's compared in constant time (SHA-256
digest) and never stored in plaintext beyond the Worker secret. The reader trades it for a
signed, HttpOnly session cookie. Responses carry HSTS, `nosniff`, a strict CSP, and
`frame-ancestors 'none'`; the one inline reader script is nonce-gated so authored page
content can never introduce executable JS into the reader origin. OAuth access/refresh
tokens are self-verifying HMACs (nothing to leak from storage), and the authorize page shows
the redirect destination so you can spot a phishing connector before approving.

> **Scope check:** Binnacle is a **single-owner** tool — one token, one wiki. It is not
> multi-tenant and isn't meant to host arbitrary strangers' pages on a shared origin. Run
> your own instance; that's the design.

---

## Reference

### Routes

Reader: `/` · `/<path>` · `/<path>?history=1` · `?v=N` · `?diff=N` · `/search?q=` ·
`/activity` · `/login` · `/logout`
MCP: `POST /mcp` · health: `/health`
OAuth: `/.well-known/oauth-authorization-server` · `/.well-known/oauth-protected-resource` ·
`/register` · `/authorize` · `/token`

Reserved top-level slugs (shadowed by routes): `mcp`, `health`, `login`, `logout`, `search`,
`activity`, `event`, `authorize`, `token`, `register`.

### Data model

`pages(id, parent_id, slug, title, content_html, sort_order, version, …)` — the `parent_id`
self-reference is the tree. `revisions` keeps the last 20 snapshots per page. `pages_fts` is
the FTS5 index. `events` is the timestamped interaction log. `oauth_clients` / `oauth_codes`
hold connector registrations and one-time PKCE codes. See `migrations/`.

### Local development

```bash
cp .dev.vars.example .dev.vars      # set a dev AUTH_TOKEN
npm run db:migrate:local            # apply schema to the local D1
npm run dev                         # wrangler dev at http://127.0.0.1:8787
npm run seed                        # optional: seed sample pages (uses the local URL/token)
```

### Manual setup

If you'd rather not run `npm run setup`:

```bash
npx wrangler login
npx wrangler d1 create binnacle     # paste the returned database_id into wrangler.toml
npm run db:migrate                  # apply schema to the remote DB
npm run secret:token                # set AUTH_TOKEN (a long random string)
npm run deploy
```

### Project layout

```
worker.ts              the entire app — MCP, reader, search, history, OAuth
wrangler.toml          Worker + D1 config (workers.dev by default)
migrations/            D1 schema (pages, search, oauth, events)
scripts/setup.mjs      one-command bootstrap (npm run setup)
scripts/seed-docs.mjs  optional starter content (npm run seed)
```

---

## Status & roadmap

- ✅ MCP server + D1 schema (tree of raw-HTML pages)
- ✅ Web reader — login cookie, collapsible tree, breadcrumbs, dark theme
- ✅ Full-text search (FTS5) — sidebar box, `/search`, and a `search` tool
- ✅ Revision history + diff view + `/activity` feed
- ✅ Interactive artifacts with server-synced, logged state (`window.bnc`, `get_events`)
- ✅ Self-contained OAuth 2.1 for the Claude mobile app / claude.ai connectors
- ⬜ Manual sidebar sort ordering
- ⬜ Nightly backup mirror to a private git repo

---

## License

[MIT](./LICENSE) — do what you like; run your own binnacle.
