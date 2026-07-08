#!/usr/bin/env node
/**
 * Seed a starter content tree into Binnacle via its own MCP.
 *
 *   Local (default):  node scripts/seed-docs.mjs
 *   Live:             BINNACLE_URL=https://binnacle.rdort-748.workers.dev \
 *                     BINNACLE_TOKEN=****  node scripts/seed-docs.mjs
 *
 * Idempotent-ish: refuses to run if a top-level "Documentation" page already
 * exists, unless FORCE=1 is set.
 */

const URL = process.env.BINNACLE_URL || "http://127.0.0.1:8799";
const TOKEN = process.env.BINNACLE_TOKEN || "test-token-123";
let idc = 0;

async function rpc(method, params) {
  const res = await fetch(`${URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }),
  });
  if (res.status === 401) throw new Error("401 unauthorized — wrong BINNACLE_TOKEN");
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r?.content?.[0]?.text ?? "";
  if (r?.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

// create(title, parentId?, html?) -> { id, path }
const create = (title, parent_id, content_html = "") =>
  call("create_page", parent_id ? { title, parent_id, content_html } : { title, content_html });

async function main() {
  const tree = await call("list_tree", {});
  if (!process.env.FORCE && (tree.tree || []).some((t) => t.title === "Documentation")) {
    console.log('A "Documentation" page already exists — nothing to do. Set FORCE=1 to seed anyway.');
    return;
  }
  console.log(`Seeding ${URL} …`);

  // ---- 📖 Documentation ---------------------------------------------------
  const docs = await create(
    "Documentation",
    null,
    `<h1>Documentation</h1>
<p>Everything about how this wiki — <strong>Binnacle</strong> — works. It's a
dead-simple tree wiki: pages form a nested tree, each page is raw HTML, you manage
it over an MCP from any device, and read it here on the web.</p>
<p class="muted">Pick a page from the sidebar, or start with <em>What is Binnacle</em>.</p>`
  );

  await create(
    "What is Binnacle",
    docs.id,
    `<h1>What is Binnacle?</h1>
<p>A personal wiki + lightweight ticket tracker that replaces a heavy Confluence/Jira
setup. The design goals:</p>
<ul>
  <li><strong>Write from anywhere</strong> — Claude edits it over an MCP, so you can add or
  change pages from your phone, laptop, or anywhere Claude runs.</li>
  <li><strong>Read anywhere</strong> — a private website you can open on any device.</li>
  <li><strong>Dead simple</strong> — no macros, no permissions matrix, no bloat. A page is
  just HTML.</li>
</ul>
<h2>What a "page" is</h2>
<p>Every node in the tree is a page and can hold <em>both</em> content and children — so a
branch like <code>Engineering</code> can have its own intro text and also contain
<code>Sprint 42</code> underneath it. Tickets are just pages too.</p>
<blockquote>If it can be a page, it doesn't need a special feature.</blockquote>`
  );

  await create(
    "How it works",
    docs.id,
    `<h1>How it works</h1>
<p>One Cloudflare Worker, one D1 (SQLite) database.</p>
<h2>Data model</h2>
<p>A single <code>pages</code> table. The <code>parent_id</code> column <em>is</em> the tree —
each page points at its parent, and the whole hierarchy falls out of that. A
<code>revisions</code> table keeps the last 20 snapshots of every page.</p>
<table>
  <thead><tr><th>Column</th><th>Meaning</th></tr></thead>
  <tbody>
    <tr><td>parent_id</td><td>NULL = top level; otherwise the page's parent</td></tr>
    <tr><td>slug</td><td>the URL segment, unique among siblings</td></tr>
    <tr><td>content_html</td><td>the raw HTML body of the page</td></tr>
    <tr><td>version</td><td>bumped on every edit; prior state saved to history</td></tr>
  </tbody>
</table>
<h2>Auth</h2>
<p>One secret token does everything: it's the bearer token for the MCP, and the same
token logs you into the web reader (which then sets a 90-day cookie). Store it once in
your password manager.</p>`
  );

  await create(
    "MCP tool reference",
    docs.id,
    `<h1>MCP tool reference</h1>
<p>Everything is managed through these tools. Ask Claude in plain language — it picks the
right one.</p>
<table>
  <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
  <tbody>
    <tr><td><code>list_tree</code></td><td>the page tree (compact JSON)</td></tr>
    <tr><td><code>get_page</code></td><td>one page by id or path</td></tr>
    <tr><td><code>create_page</code></td><td>new page (title, optional parent/slug/HTML)</td></tr>
    <tr><td><code>update_page</code></td><td>edit title/content; snapshots the prior version</td></tr>
    <tr><td><code>move_page</code></td><td>reparent/reorder; the subtree moves with it</td></tr>
    <tr><td><code>delete_page</code></td><td>delete (recursive for subtrees)</td></tr>
    <tr><td><code>list_revisions</code></td><td>a page's saved versions</td></tr>
    <tr><td><code>restore_revision</code></td><td>roll a page back to a version</td></tr>
    <tr><td><code>search</code></td><td>full-text search across titles + bodies</td></tr>
  </tbody>
</table>
<p class="muted">Example: "create a page called Meeting Notes under Engineering" →
<code>create_page</code>.</p>`
  );

  await create(
    "Reader &amp; routes",
    docs.id,
    `<h1>Reader &amp; routes</h1>
<p>The web reader is read-only and cookie-gated. Useful URLs:</p>
<table>
  <thead><tr><th>Route</th><th>Shows</th></tr></thead>
  <tbody>
    <tr><td><code>/</code></td><td>home</td></tr>
    <tr><td><code>/&lt;path&gt;</code></td><td>a page, e.g. <code>/documentation/how-it-works</code></td></tr>
    <tr><td><code>/&lt;path&gt;?history=1</code></td><td>version history for that page</td></tr>
    <tr><td><code>/&lt;path&gt;?v=N</code></td><td>view an old version</td></tr>
    <tr><td><code>/&lt;path&gt;?diff=N</code></td><td>diff that version against current</td></tr>
    <tr><td><code>/search?q=…</code></td><td>full-text search</td></tr>
    <tr><td><code>/activity</code></td><td>recent edits across all pages</td></tr>
  </tbody>
</table>
<p class="muted">Reserved top-level slugs (shadowed by routes): mcp, health, login, logout,
search, activity.</p>`
  );

  await create(
    "Deploying",
    docs.id,
    `<h1>Deploying</h1>
<p>Push to <code>main</code> and Cloudflare Workers Builds deploys automatically.</p>
<pre><code>git push                 # deploys the worker
npm run db:migrate       # only after a new migration (wrangler deploy skips migrations)</code></pre>
<p>Set or rotate the secret token with:</p>
<pre><code>npx wrangler secret put AUTH_TOKEN</code></pre>`
  );

  // ---- 🧭 How-to ----------------------------------------------------------
  const howto = await create(
    "How-to",
    null,
    `<h1>How-to</h1><p>Short, task-focused guides for everyday use.</p>`
  );
  await create(
    "Create &amp; organize pages",
    howto.id,
    `<h1>Create &amp; organize pages</h1>
<ul>
  <li><strong>New page:</strong> ask Claude to "create a page called X" (optionally "under Y").</li>
  <li><strong>Move it:</strong> "move X under Z" — the whole subtree comes along.</li>
  <li><strong>Rename / edit:</strong> "rename X to Y" or "update the X page to say …".</li>
  <li><strong>Delete:</strong> "delete X" (add "and everything under it" for a subtree).</li>
</ul>
<p>Slugs are generated from titles and de-duplicated automatically among siblings.</p>`
  );
  await create(
    "Track tickets as pages",
    howto.id,
    `<h1>Track tickets as pages</h1>
<p>There's no separate ticket system — a ticket is just a page. A simple convention:</p>
<ul>
  <li>Put tickets under a <code>Tickets</code> branch (or per-project branches).</li>
  <li>Start the title with an id, e.g. <code>BIN-3 · Add sort ordering</code>.</li>
  <li>Keep a status line at the top of the body.</li>
</ul>
<p>Use the <code>/activity</code> feed and per-page history to see what moved and when.</p>`
  );
  await create(
    "Search &amp; history",
    howto.id,
    `<h1>Search &amp; history</h1>
<ul>
  <li><strong>Search:</strong> the box in the sidebar, or <code>/search?q=…</code>. Multiple words
  are ANDed and prefix-matched.</li>
  <li><strong>History:</strong> every page footer has a <em>History</em> link — see prior versions,
  view any one, or diff it against current.</li>
  <li><strong>Restore:</strong> ask Claude to "restore the X page to version N".</li>
</ul>`
  );

  // ---- ✅ Roadmap ---------------------------------------------------------
  await create(
    "Roadmap",
    null,
    `<h1>Roadmap</h1>
<p>What's built and what's next. This is itself a page — edit it as things change.</p>
<h2>Done</h2>
<ul>
  <li>✅ MCP server + D1 schema (tree of raw-HTML pages)</li>
  <li>✅ Web reader — login cookie, collapsible tree, light/dark</li>
  <li>✅ Full-text search (FTS5) — sidebar box, <code>/search</code>, and a search tool</li>
  <li>✅ Revision history, diff view, and an activity feed</li>
</ul>
<h2>To do</h2>
<ul>
  <li>⬜ Manual sort ordering of pages in the sidebar</li>
  <li>⬜ Custom domain <code>binnacle.dort.zone</code> (parked — cosmetic)</li>
  <li>⬜ Nightly backup mirror to a private git repo</li>
  <li>⬜ Migrate the worth-keeping pages over from Confluence</li>
</ul>
<blockquote>Add your own ideas here — it's just a page.</blockquote>`
  );

  // ---- 🎫 Tickets (example) ----------------------------------------------
  const tickets = await create(
    "Tickets",
    null,
    `<h1>Tickets</h1><p>Work items, one page each. Example below — replace with your own.</p>`
  );
  await create(
    "BIN-1 · Ship the wiki",
    tickets.id,
    `<h1>BIN-1 · Ship the wiki</h1>
<p><strong>Status:</strong> Done · <strong>Priority:</strong> High</p>
<p>Stand up Binnacle end-to-end: MCP, reader, search, history. Shipped.</p>`
  );
  await create(
    "BIN-2 · Add sort ordering",
    tickets.id,
    `<h1>BIN-2 · Add sort ordering</h1>
<p><strong>Status:</strong> To do · <strong>Priority:</strong> Medium</p>
<p>Let pages be manually ordered in the sidebar rather than by title.</p>`
  );

  // ---- 🗒 Notes (empty inbox) --------------------------------------------
  await create(
    "Notes",
    null,
    `<h1>Notes</h1><p class="muted">A catch-all inbox. Drop quick notes here and file them later.</p>`
  );

  const after = await call("list_tree", {});
  const roots = (after.tree || []).map((t) => `${t.title} (${(t.children || []).length})`);
  console.log("Done. Top-level pages: " + roots.join(", "));
}

main().catch((e) => {
  console.error("Seed failed:", e.message);
  process.exit(1);
});
