/**
 * Binnacle — a dead-simple tree wiki.
 *
 * One Cloudflare Worker, three concerns:
 *   - POST /mcp   remote MCP server (JSON-RPC over Streamable HTTP), bearer-gated.
 *   - /login      (Phase 2) trades the token for a signed cookie for the reader.
 *   - everything  (Phase 2) server-rendered read-only view.
 *
 * Phase 1 (this file) ships the MCP surface: pages live in D1, managed entirely
 * through the tools below. The reader is a stub for now.
 */

export interface Env {
  DB: D1Database;
  AUTH_TOKEN: string;
  // Optional: when set, full-document artifacts are served from (and embedded
  // from) this separate origin, so their scripts run cross-origin to the reader
  // — real isolation, and localStorage keeps working. Requires READER_ORIGIN too.
  // When unset, artifacts render in a sandboxed same-origin iframe instead.
  RAW_ORIGIN?: string;
  READER_ORIGIN?: string;
}

const MAX_REVISIONS = 20;
const SERVER_INFO = { name: "binnacle", version: "0.1.0" };

const BINNACLE_INSTRUCTIONS = `Binnacle is a tree wiki: a nested tree of pages, each page is raw HTML you author.

DESIGN PHILOSOPHY — this is a tree of bespoke artifacts, NOT a uniform wiki. Do not force
every page into one house style or make pages look the same. Design each page as the best
self-contained artifact for its content, with full creative freedom (layout, fonts, colours,
interactivity).

Two kinds of page content, pick per page:

1. FULL ARTIFACT (preferred for anything rich — dashboards, trackers, showpieces): make
   content_html a COMPLETE HTML document (starts with <!doctype html> or <html>, with its own
   <head>, <style>, fonts, and <script>). It renders ISOLATED in its own frame, so its styling
   never clashes with anything else and you have total control. Inline <script> runs; use
   localStorage for persistence (e.g. checklists, set logs). Load web fonts via <link>/@import.
   Use links with normal hrefs to other pages (e.g. /parent/child) — they navigate the whole
   reader automatically.

2. QUICK FRAGMENT (fine for simple reference pages): a plain HTML fragment (no <html> wrapper)
   that inherits the reader's dark theme. Reusable classes available: .hero (+ h1, .sub),
   .lead, .chips/.chip, .stats/.stat (.n number, .l label), .callout with a variant
   (info/tip/success/warn/danger) wrapping <span class="ico">emoji</span><div class="body">…,
   .cards + <a class="card"> (.t title, .d desc), table.kv, ul.checklist (li.done = checked),
   .tags/.tag, and .st status pills (ok/need/crit).

Prefer a full bespoke artifact whenever a page would benefit from a distinct look or
interactivity. Titles are plain text (no HTML). Keep slugs implicit — they derive from titles.`;
const DEFAULT_PROTOCOL = "2024-11-05";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageRow {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  content_html: string;
  sort_order: number;
  version: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "untitled";
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...SECURITY_HEADERS, ...extraHeaders },
  });
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function extractToken(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const x = req.headers.get("x-auth-token");
  if (x) return x.trim();
  const q = url.searchParams.get("token");
  if (q) return q.trim();
  return null;
}

// Constant-time comparison of two equal-length strings (e.g. two HMAC hex
// digests). Only safe when both operands are already fixed-length.
function tokenMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Timing-safe equality for a user-supplied secret vs. the real one. Comparing
// SHA-256 digests keeps the compare constant-time AND leaks nothing about the
// real token's length (both digests are always 32 bytes).
async function digestEq(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", te.encode(a)),
    crypto.subtle.digest("SHA-256", te.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function loadAllPages(env: Env): Promise<PageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, parent_id, slug, title, content_html, sort_order, version, created_at, updated_at
     FROM pages ORDER BY sort_order, title`
  ).all<PageRow>();
  return results ?? [];
}

async function getPageById(env: Env, id: string): Promise<PageRow | null> {
  return await env.DB.prepare(
    `SELECT id, parent_id, slug, title, content_html, sort_order, version, created_at, updated_at
     FROM pages WHERE id = ?`
  )
    .bind(id)
    .first<PageRow>();
}

function buildIndex(pages: PageRow[]) {
  const byId = new Map<string, PageRow>();
  const childrenOf = new Map<string | null, PageRow[]>();
  for (const p of pages) {
    byId.set(p.id, p);
    const key = p.parent_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(p);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
  }
  return { byId, childrenOf };
}

function fullPath(byId: Map<string, PageRow>, id: string): string {
  const segs: string[] = [];
  let cur: PageRow | undefined = byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    segs.unshift(cur.slug);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return "/" + segs.join("/");
}

function resolvePath(pages: PageRow[], path: string): PageRow | null {
  const { childrenOf } = buildIndex(pages);
  const segs = path.split("/").map((s) => s.trim()).filter(Boolean);
  let parentId: string | null = null;
  let match: PageRow | null = null;
  for (const seg of segs) {
    const siblings: PageRow[] = childrenOf.get(parentId) ?? [];
    const found: PageRow | undefined = siblings.find((p) => p.slug === seg);
    if (!found) return null;
    match = found;
    parentId = found.id;
  }
  return match;
}

// Descendants (inclusive) of a page id.
function subtreeIds(childrenOf: Map<string | null, PageRow[]>, rootId: string): string[] {
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c.id);
  }
  return out;
}

// --- full-text search index maintenance -----------------------------------

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ftsUpsert(env: Env, id: string, title: string, contentHtml: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).bind(id).run();
  await env.DB
    .prepare(`INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)`)
    .bind(id, title, stripHtml(contentHtml))
    .run();
}

async function ftsDelete(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM pages_fts WHERE page_id IN (${ph})`).bind(...ids).run();
}

async function uniqueSlug(
  env: Env,
  parentId: string | null,
  desired: string,
  excludeId?: string
): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT slug FROM pages WHERE parent_id IS ? AND id IS NOT ?`
  )
    .bind(parentId, excludeId ?? null)
    .all<{ slug: string }>();
  const taken = new Set((results ?? []).map((r) => r.slug));
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired}-${n}`)) n++;
  return `${desired}-${n}`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type ToolResult = Record<string, unknown>;

async function tListTree(env: Env, args: any): Promise<ToolResult> {
  const pages = await loadAllPages(env);
  const { byId, childrenOf } = buildIndex(pages);
  const rootId: string | null = args?.root ?? null;
  const maxDepth: number = typeof args?.depth === "number" ? args.depth : Infinity;

  const node = (p: PageRow, depth: number): any => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    hasContent: p.content_html.trim().length > 0,
    children:
      depth >= maxDepth
        ? undefined
        : (childrenOf.get(p.id) ?? []).map((c) => node(c, depth + 1)),
  });

  const roots = rootId
    ? (byId.has(rootId) ? [byId.get(rootId)!] : [])
    : (childrenOf.get(null) ?? []);
  return { tree: roots.map((r) => node(r, 0)) };
}

async function tGetPage(env: Env, args: any): Promise<ToolResult> {
  let page: PageRow | null = null;
  if (args?.id) {
    page = await getPageById(env, args.id);
  } else if (args?.path) {
    page = resolvePath(await loadAllPages(env), args.path);
  } else {
    throw new Error("get_page requires `id` or `path`");
  }
  if (!page) throw new Error("page not found");
  const { byId } = buildIndex(await loadAllPages(env));
  return {
    id: page.id,
    parent_id: page.parent_id,
    path: fullPath(byId, page.id),
    title: page.title,
    content_html: page.content_html,
    version: page.version,
    updated_at: page.updated_at,
  };
}

async function tCreatePage(env: Env, args: any): Promise<ToolResult> {
  if (!args?.title) throw new Error("create_page requires `title`");
  const parentId: string | null = args.parent_id ?? null;
  if (parentId && !(await getPageById(env, parentId))) throw new Error("parent_id not found");
  const slug = await uniqueSlug(env, parentId, slugify(args.slug || args.title));
  const id = crypto.randomUUID();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO pages (id, parent_id, slug, title, content_html, sort_order, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(id, parentId, slug, args.title, args.content_html ?? "", args.sort_order ?? 0, ts, ts)
    .run();
  await ftsUpsert(env, id, args.title, args.content_html ?? "");
  const { byId } = buildIndex(await loadAllPages(env));
  return { id, path: fullPath(byId, id), title: args.title, version: 1 };
}

async function tUpdatePage(env: Env, args: any): Promise<ToolResult> {
  if (!args?.id) throw new Error("update_page requires `id`");
  const page = await getPageById(env, args.id);
  if (!page) throw new Error("page not found");

  const changingContent = typeof args.content_html === "string";
  const changingTitle = typeof args.title === "string";
  if (!changingContent && !changingTitle) throw new Error("nothing to update");

  // Snapshot the current (pre-edit) state into revisions.
  await env.DB.prepare(
    `INSERT INTO revisions (id, page_id, version, title, content_html, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      page.id,
      page.version,
      page.title,
      page.content_html,
      args.summary ?? null,
      now()
    )
    .run();

  const newVersion = page.version + 1;
  await env.DB.prepare(
    `UPDATE pages SET title = ?, content_html = ?, version = ?, updated_at = ? WHERE id = ?`
  )
    .bind(
      changingTitle ? args.title : page.title,
      changingContent ? args.content_html : page.content_html,
      newVersion,
      now(),
      page.id
    )
    .run();

  // Prune to the last MAX_REVISIONS.
  await env.DB.prepare(
    `DELETE FROM revisions WHERE page_id = ? AND version NOT IN (
       SELECT version FROM revisions WHERE page_id = ? ORDER BY version DESC LIMIT ?
     )`
  )
    .bind(page.id, page.id, MAX_REVISIONS)
    .run();

  await ftsUpsert(
    env,
    page.id,
    changingTitle ? args.title : page.title,
    changingContent ? args.content_html : page.content_html
  );

  const { byId } = buildIndex(await loadAllPages(env));
  return { id: page.id, path: fullPath(byId, page.id), version: newVersion };
}

async function tMovePage(env: Env, args: any): Promise<ToolResult> {
  if (!args?.id) throw new Error("move_page requires `id`");
  const page = await getPageById(env, args.id);
  if (!page) throw new Error("page not found");
  const newParent: string | null = args.new_parent_id ?? null;

  if (newParent) {
    if (newParent === page.id) throw new Error("cannot move a page into itself");
    const { childrenOf } = buildIndex(await loadAllPages(env));
    if (subtreeIds(childrenOf, page.id).includes(newParent))
      throw new Error("cannot move a page into its own descendant");
    if (!(await getPageById(env, newParent))) throw new Error("new_parent_id not found");
  }

  const slug = await uniqueSlug(env, newParent, page.slug, page.id);
  const sortOrder = typeof args.sort_order === "number" ? args.sort_order : page.sort_order;
  await env.DB.prepare(
    `UPDATE pages SET parent_id = ?, slug = ?, sort_order = ?, updated_at = ? WHERE id = ?`
  )
    .bind(newParent, slug, sortOrder, now(), page.id)
    .run();

  const { byId } = buildIndex(await loadAllPages(env));
  return { id: page.id, path: fullPath(byId, page.id) };
}

async function tDeletePage(env: Env, args: any): Promise<ToolResult> {
  if (!args?.id) throw new Error("delete_page requires `id`");
  const page = await getPageById(env, args.id);
  if (!page) throw new Error("page not found");
  const { childrenOf } = buildIndex(await loadAllPages(env));
  const ids = subtreeIds(childrenOf, page.id);
  if (ids.length > 1 && !args.recursive)
    throw new Error(`page has ${ids.length - 1} descendant(s); pass recursive: true to delete them`);

  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM revisions WHERE page_id IN (${placeholders})`).bind(...ids).run();
  await env.DB.prepare(`DELETE FROM pages WHERE id IN (${placeholders})`).bind(...ids).run();
  await ftsDelete(env, ids);
  return { deleted: ids.length };
}

async function tListRevisions(env: Env, args: any): Promise<ToolResult> {
  if (!args?.id) throw new Error("list_revisions requires `id`");
  const { results } = await env.DB.prepare(
    `SELECT version, title, summary, created_at FROM revisions WHERE page_id = ? ORDER BY version DESC`
  )
    .bind(args.id)
    .all();
  return { revisions: results ?? [] };
}

async function tRestoreRevision(env: Env, args: any): Promise<ToolResult> {
  if (!args?.id || typeof args.version !== "number")
    throw new Error("restore_revision requires `id` and `version`");
  const rev = await env.DB.prepare(
    `SELECT title, content_html FROM revisions WHERE page_id = ? AND version = ?`
  )
    .bind(args.id, args.version)
    .first<{ title: string; content_html: string }>();
  if (!rev) throw new Error("revision not found");
  // Restoring is itself an edit, so route through update to snapshot current state.
  return await tUpdatePage(env, {
    id: args.id,
    title: rev.title,
    content_html: rev.content_html,
    summary: `restored from v${args.version}`,
  });
}

// Turn free text into a safe FTS5 prefix-AND match string ("foo bar" -> foo* bar*).
function ftsQuery(raw: string): string {
  const terms = (raw.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((t) => `${t}*`);
  return terms.join(" ");
}

async function tSearch(env: Env, args: any): Promise<ToolResult> {
  const match = ftsQuery(String(args?.query ?? ""));
  if (!match) return { results: [] };
  const { results } = await env.DB.prepare(
    `SELECT page_id, title, snippet(pages_fts, 1, '', '', '…', 15) AS snip
     FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT 30`
  )
    .bind(match)
    .all<{ page_id: string; title: string; snip: string }>();
  const { byId } = buildIndex(await loadAllPages(env));
  return {
    results: (results ?? [])
      .filter((r) => byId.has(r.page_id))
      .map((r) => ({
        id: r.page_id,
        title: r.title,
        path: fullPath(byId, r.page_id),
        snippet: r.snip,
      })),
  };
}

// ---------------------------------------------------------------------------
// Tool registry (name, schema, handler)
// ---------------------------------------------------------------------------

const TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (env: Env, args: any) => Promise<ToolResult>;
}> = [
  {
    name: "list_tree",
    description:
      "Return the page tree as compact nested JSON (id, title, slug, hasContent, children). Optionally pass `root` (a page id) to scope to a subtree, and `depth` to limit levels.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "page id to use as the root (default: whole tree)" },
        depth: { type: "number", description: "max levels to descend" },
      },
    },
    handler: tListTree,
  },
  {
    name: "get_page",
    description: "Fetch one page's full content by `id` or by `path` (e.g. /engineering/sprint-42).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
      },
    },
    handler: tGetPage,
  },
  {
    name: "create_page",
    description:
      "Create a page. `title` required. Optional `parent_id` (omit for top-level), `slug` (auto from title), `sort_order`, and `content_html`. content_html is either a COMPLETE HTML document (<!doctype html>/<html> with its own <style>/fonts/<script>) — renders isolated as a bespoke artifact — OR a plain fragment that inherits the reader theme. Design each page freely; don't force a shared house style. Prefer a full self-contained artifact for anything rich or interactive.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        parent_id: { type: "string" },
        slug: { type: "string" },
        content_html: { type: "string" },
        sort_order: { type: "number" },
      },
    },
    handler: tCreatePage,
  },
  {
    name: "update_page",
    description:
      "Update a page's `title` and/or `content_html`. content_html may be a complete HTML document (renders isolated as a bespoke artifact) or a theme-inheriting fragment. The previous state is snapshotted to history. Pass a short `summary` describing the change.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content_html: { type: "string" },
        summary: { type: "string" },
      },
    },
    handler: tUpdatePage,
  },
  {
    name: "move_page",
    description:
      "Reparent and/or reorder a page. Pass `new_parent_id` (omit/null for top-level) and/or `sort_order`. The whole subtree moves with it.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        new_parent_id: { type: "string" },
        sort_order: { type: "number" },
      },
    },
    handler: tMovePage,
  },
  {
    name: "delete_page",
    description: "Delete a page. If it has children, pass `recursive: true` to delete the subtree.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        recursive: { type: "boolean" },
      },
    },
    handler: tDeletePage,
  },
  {
    name: "list_revisions",
    description: "List a page's saved revisions (version, title, summary, created_at), newest first.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    handler: tListRevisions,
  },
  {
    name: "restore_revision",
    description: "Restore a page to a prior `version`. Current state is snapshotted first.",
    inputSchema: {
      type: "object",
      required: ["id", "version"],
      properties: { id: { type: "string" }, version: { type: "number" } },
    },
    handler: tRestoreRevision,
  },
  {
    name: "search",
    description:
      "Full-text search page titles and body. Returns matches with id, title, path, and a text snippet. Multiple words are ANDed (prefix-matched).",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    handler: tSearch,
  },
];

// ---------------------------------------------------------------------------
// MCP (JSON-RPC over Streamable HTTP)
// ---------------------------------------------------------------------------

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(env: Env, msg: any): Promise<object | null> {
  const { id, method, params } = msg ?? {};

  // Notifications (no id) get no response body.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: BINNACLE_INSTRUCTIONS,
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // ack, no body

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const result = await tool.handler(env, params?.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        };
      } catch (e: any) {
        // Tool-level error: report inside result so the model can read it.
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
            isError: true,
          },
        };
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

async function handleMcp(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET")
    // We don't offer a server-initiated SSE stream.
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const token = extractToken(req, url);
  if (!(await isAuthorizedMcp(env, token)))
    return new Response(JSON.stringify(rpcError(null, -32001, "unauthorized")), {
      status: 401,
      headers: {
        "content-type": "application/json",
        ...CORS,
        "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
      },
    });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "parse error"), 400);
  }

  const sessionHeader = { "mcp-session-id": req.headers.get("mcp-session-id") || crypto.randomUUID() };

  // Support JSON-RPC batches.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleRpc(env, m)))).filter(Boolean);
    if (responses.length === 0) return new Response(null, { status: 202, headers: { ...CORS, ...sessionHeader } });
    return json(responses, 200, sessionHeader);
  }

  const response = await handleRpc(env, body);
  if (response === null) return new Response(null, { status: 202, headers: { ...CORS, ...sessionHeader } });
  return json(response, 200, sessionHeader);
}

// ---------------------------------------------------------------------------
// Reader — cookie auth
// ---------------------------------------------------------------------------

const COOKIE_NAME = "bnc_session";
const COOKIE_MAX_AGE = 90 * 24 * 3600; // 90 days
const te = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(msg));
  return toHex(sig);
}

async function makeSessionCookie(env: Env): Promise<string> {
  const exp = Date.now() + COOKIE_MAX_AGE * 1000;
  const sig = await hmacHex(env.AUTH_TOKEN, String(exp));
  return `${COOKIE_NAME}=${exp}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function hasValidSession(req: Request, env: Env): Promise<boolean> {
  const c = readCookie(req, COOKIE_NAME);
  if (!c) return false;
  const dot = c.lastIndexOf(".");
  if (dot < 0) return false;
  const exp = c.slice(0, dot);
  const sig = c.slice(dot + 1);
  const expNum = Number(exp);
  if (!expNum || expNum < Date.now()) return false;
  return tokenMatches(sig, await hmacHex(env.AUTH_TOKEN, exp));
}

// ---------------------------------------------------------------------------
// Reader — rendering
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

// Applied to every first-party response.
const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Default CSP for script-free HTML (login, authorize, error, 404 chrome). The
// reader shell overrides this with a nonce-based policy (see readerCsp).
const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com data:; img-src 'self' data: https:; frame-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// The reader shell has exactly one inline <script> (iframe autosize), gated by a
// per-response nonce so authored page content can never introduce executable JS.
function readerCsp(nonce: string, rawOrigin?: string): string {
  const frame = rawOrigin ? `'self' ${rawOrigin}` : "'self'";
  return (
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; ` +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
    `img-src 'self' data: https:; frame-src ${frame}; connect-src 'self'; object-src 'none'; base-uri 'none'; ` +
    "frame-ancestors 'none'; form-action 'self'"
  );
}

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
      "x-frame-options": "DENY",
      "content-security-policy": DEFAULT_CSP,
      ...headers,
    },
  });
}

const CSS = `
:root{--bg:#111;--surface:#1a1a1a;--surface2:#222;--border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.16);--fg:#f0f0f0;--muted:#8a8a8a;--accent:#e8ff00;--code-bg:#1c1c1c;--sidebar-bg:#161616;--info:#5bc8ff;--success:#4cff91;--warn:#ffb84d;--danger:#ff6b6b;--display:'Bebas Neue','DM Sans',sans-serif}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);display:flex;min-height:100vh;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.muted{color:var(--muted)}
.sidebar{width:272px;flex-shrink:0;background:var(--sidebar-bg);border-right:1px solid var(--border);padding:20px 16px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:block;font-family:var(--display);font-weight:400;font-size:1.7rem;letter-spacing:1px;color:var(--accent);margin-bottom:16px}.brand:hover{text-decoration:none}
.navwrap>summary{display:none}
.tree ul{list-style:none;margin:0;padding-left:14px}.tree>nav>ul,.tree>ul{padding-left:0}.tree li{margin:1px 0}
.nav-link{display:block;padding:3px 8px;border-radius:6px;color:var(--fg);font-size:.92rem}
.nav-link:hover{background:var(--surface2);text-decoration:none}.nav-link.active{background:var(--accent);color:#111;font-weight:600}
.tree details>summary{list-style:none;cursor:pointer;display:flex;align-items:center}
.tree details>summary::-webkit-details-marker{display:none}
.tree details>summary::before{content:"\\25B8";color:var(--muted);font-size:.7rem;margin-right:2px;transition:transform .1s;display:inline-block;width:12px}
.tree details[open]>summary::before{transform:rotate(90deg)}
.tree details>summary .nav-link{flex:1}
.logout{display:block;margin-top:20px;font-size:.85rem;color:var(--muted)}
.content{flex:1;min-width:0;display:flex;justify-content:center;padding:40px 32px}
.content article{width:100%;max-width:760px}
.crumbs{font-size:.78rem;color:var(--muted);margin-bottom:20px;text-transform:uppercase;letter-spacing:.5px}.crumbs a{color:var(--muted)}.crumbs .sep{margin:0 6px;opacity:.5}
.prose{font-size:1rem}
.prose h1{font-size:2rem;line-height:1.15;margin:.2em 0 .5em;font-weight:600}
.prose h2{font-size:1.15rem;margin:1.8em 0 .6em;padding-bottom:.3em;border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:.6px}
.prose h3{font-size:1.02rem;margin:1.4em 0 .4em;font-weight:600}
.prose p{margin:.8em 0}.prose ul,.prose ol{padding-left:1.4em;margin:.8em 0}.prose li{margin:.3em 0}
.prose code{background:var(--surface2);padding:.15em .4em;border-radius:4px;font-size:.85em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}
.prose pre{background:var(--surface);padding:14px 16px;border-radius:10px;overflow-x:auto;margin:1em 0;border:1px solid var(--border)}.prose pre code{background:none;padding:0;color:var(--fg)}
.prose blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid var(--border2);color:var(--muted)}
.prose table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9rem;display:block;overflow-x:auto}
.prose th,.prose td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top}.prose th{background:var(--surface2);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.3px}
.prose tbody tr:nth-child(even){background:rgba(255,255,255,.02)}
.prose img{max-width:100%;height:auto}.prose a{text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 45%,transparent)}.prose a:hover{border-bottom-color:var(--accent)}
.prose hr{border:none;border-top:1px solid var(--border);margin:2em 0}
.index{list-style:none;padding-left:0}.index li{margin:.4em 0}.index a{font-weight:500}
.meta{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.search{margin-bottom:14px}
.search input{width:100%;padding:8px 11px;border:1px solid var(--border2);border-radius:8px;background:var(--surface);color:var(--fg);font-size:.9rem}
.results{list-style:none;padding-left:0}.results li{margin:0 0 20px}
.results>li>a{font-weight:600;font-size:1.05rem}
.results .crumb-sm{font-size:.78rem;color:var(--muted);margin:2px 0}
.results .snip{margin:.3em 0 0;font-size:.92rem;color:var(--fg)}
.results mark{background:var(--accent);color:#111;padding:0 2px;border-radius:3px}

/* content components — for authored / migrated pages */
.prose .hero{margin:0 0 26px;padding:24px 26px;border:1px solid var(--border);border-radius:14px;background:linear-gradient(135deg,var(--surface),var(--bg))}
.prose .hero h1{margin:0 0 8px;font-family:var(--display);font-weight:400;font-size:2.7rem;letter-spacing:1px;line-height:1;color:var(--accent);border:none;padding:0;text-transform:none}
.prose .hero .sub{color:var(--muted);font-size:.92rem;margin:0;text-transform:uppercase;letter-spacing:.6px;line-height:1.5}
.prose .chips{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0;padding:0;list-style:none}
.prose .chip{display:inline-flex;align-items:center;gap:5px;font-size:.77rem;padding:4px 12px;border:1px solid var(--border2);border-radius:999px;background:var(--surface);color:var(--fg)}
.prose .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:22px 0}
.prose .stat{border:1px solid var(--border);border-radius:10px;padding:13px 15px;background:var(--surface)}
.prose .stat .n{font-family:var(--display);font-weight:400;font-size:1.95rem;line-height:1;color:var(--accent);letter-spacing:.5px}
.prose .stat .l{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-top:6px}
.prose .callout{display:flex;gap:12px;margin:18px 0;padding:14px 16px;border:1px solid var(--border);border-left-width:3px;border-radius:10px;background:var(--surface)}
.prose .callout .ico{font-size:1.15rem;line-height:1.5;flex-shrink:0}
.prose .callout .body{flex:1;min-width:0}
.prose .callout .body>:first-child{margin-top:0}.prose .callout .body>:last-child{margin-bottom:0}
.prose .callout.info{border-left-color:var(--info);background:color-mix(in srgb,var(--info) 8%,var(--surface))}
.prose .callout.tip,.prose .callout.success{border-left-color:var(--success);background:color-mix(in srgb,var(--success) 8%,var(--surface))}
.prose .callout.warn{border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 9%,var(--surface))}
.prose .callout.danger{border-left-color:var(--danger);background:color-mix(in srgb,var(--danger) 9%,var(--surface))}
.prose .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:22px 0;padding:0;list-style:none}
.prose a.card{display:block;border:1px solid var(--border);border-radius:12px;padding:16px 18px;background:var(--surface);text-decoration:none;color:var(--fg);transition:border-color .12s,transform .12s}
.prose a.card:hover{border-color:var(--border2);text-decoration:none;transform:translateY(-2px)}
.prose a.card .t{font-weight:600;margin-bottom:4px}
.prose a.card .d{font-size:.84rem;color:var(--muted)}
.prose table.kv th{width:34%;text-align:left;background:var(--surface2);font-weight:600;color:var(--fg);text-transform:none;letter-spacing:0;font-size:.88rem}
.prose ul.checklist{list-style:none;padding-left:0}
.prose ul.checklist li{padding:4px 0 4px 28px;position:relative}
.prose ul.checklist li::before{content:"";position:absolute;left:0;top:4px;width:15px;height:15px;border:1.5px solid var(--border2);border-radius:4px}
.prose ul.checklist li.done{color:var(--muted)}
.prose ul.checklist li.done::before{border-color:var(--success);background:color-mix(in srgb,var(--success) 18%,transparent)}
.prose ul.checklist li.done::after{content:"";position:absolute;left:5px;top:6px;width:4px;height:8px;border:1.5px solid var(--success);border-top:none;border-left:none;transform:rotate(45deg)}
.prose .tags{display:flex;flex-wrap:wrap;gap:6px;padding:0;list-style:none;margin:12px 0}
.prose .tag{font-size:.74rem;padding:2px 9px;border-radius:999px;background:var(--surface2);border:1px solid var(--border2);color:var(--muted)}
.prose .lead{font-size:1.1rem;color:var(--muted);margin:0 0 18px}
.prose .st{display:inline-block;font-size:.7rem;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--border2);white-space:nowrap}
.prose .st.ok{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent);border-color:color-mix(in srgb,var(--success) 30%,transparent)}
.prose .st.need{color:var(--warn);background:color-mix(in srgb,var(--warn) 13%,transparent);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.prose .st.crit{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent);border-color:color-mix(in srgb,var(--danger) 30%,transparent)}
.artifact{width:100%;border:1px solid var(--border);border-radius:14px;display:block;min-height:70vh;background:var(--bg);color-scheme:light dark}

.side-link{display:block;margin-top:14px;font-size:.85rem;color:var(--muted)}
.rev-banner{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:.9rem;margin-bottom:22px}
.history{list-style:none;padding-left:0}
.history li{padding:8px 0;border-bottom:1px solid var(--border);font-size:.92rem}
.badge{display:inline-block;background:var(--surface2);border:1px solid var(--border2);border-radius:5px;padding:0 6px;font-size:.74rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-right:6px}
.history .cur{color:var(--accent);font-weight:600;margin-right:4px}
pre.diff{background:var(--surface);padding:14px 16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-size:.85rem;line-height:1.7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--border)}
pre.diff del{background:rgba(255,107,107,.18);color:var(--danger);text-decoration:line-through}
pre.diff ins{background:rgba(76,255,145,.18);color:var(--success);text-decoration:none}
.login-wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.login-card{width:100%;max-width:360px;text-align:center}.login-card h1{font-family:var(--display);font-weight:400;font-size:2.3rem;letter-spacing:1px;margin-bottom:8px;color:var(--accent)}
.login-card form{margin-top:20px;display:flex;flex-direction:column;gap:12px}
.login-card input{padding:11px 13px;border:1px solid var(--border2);border-radius:8px;background:var(--surface);color:var(--fg);font-size:1rem}
.login-card button{padding:11px 13px;border:none;border-radius:8px;background:var(--accent);color:#111;font-size:1rem;font-weight:700;cursor:pointer;letter-spacing:.5px}
.login-card .err{color:var(--danger);font-size:.9rem;margin-top:10px}
@media (max-width:720px){body{flex-direction:column}.sidebar{width:auto;height:auto;position:static;border-right:none;border-bottom:1px solid var(--border)}.navwrap>summary{display:block;cursor:pointer;font-size:.9rem;color:var(--muted);padding:4px 0}.content{padding:24px 18px}}
`;

function pageShell(title: string, sidebar: string, main: string, nonce: string): string {
  // The artifact iframe is isolated (sandboxed and/or cross-origin), so we can no
  // longer read its document to size it. Instead the artifact posts its height and
  // we listen for it — works across the origin boundary, matched by source window.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Binnacle</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${CSS}</style></head><body><aside class="sidebar">${sidebar}</aside><main class="content"><article>${main}</article></main><script nonce="${nonce}">(function(){window.addEventListener('message',function(e){var d=e&&e.data;if(!d||typeof d.__bnc_h!=='number')return;document.querySelectorAll('iframe.artifact').forEach(function(f){if(f.contentWindow===e.source)f.style.height=(d.__bnc_h+2)+'px'})})})();</script></body></html>`;
}

// Render the reader shell with a fresh CSP nonce for its one inline script.
function shellResponse(
  title: string,
  sidebar: string,
  main: string,
  status = 200,
  rawOrigin?: string
): Response {
  const nonce = randomToken(16);
  return htmlResponse(pageShell(title, sidebar, main, nonce), status, {
    "content-security-policy": readerCsp(nonce, rawOrigin),
  });
}

function renderNav(
  childrenOf: Map<string | null, PageRow[]>,
  byId: Map<string, PageRow>,
  parentId: string | null,
  activeIds: Set<string>,
  currentId: string | null
): string {
  const kids = childrenOf.get(parentId) ?? [];
  if (!kids.length) return "";
  let out = "<ul>";
  for (const p of kids) {
    const path = fullPath(byId, p.id);
    const cls = p.id === currentId ? "nav-link active" : "nav-link";
    const link = `<a class="${cls}" href="${esc(path)}">${esc(p.title)}</a>`;
    if ((childrenOf.get(p.id) ?? []).length) {
      const open = activeIds.has(p.id) ? " open" : "";
      out += `<li><details${open}><summary>${link}</summary>${renderNav(childrenOf, byId, p.id, activeIds, currentId)}</details></li>`;
    } else {
      out += `<li>${link}</li>`;
    }
  }
  return out + "</ul>";
}

function renderSidebar(navHtml: string, query = ""): string {
  return `<a class="brand" href="/">🧭 Binnacle</a><form class="search" action="/search" method="get"><input type="search" name="q" placeholder="Search…" value="${esc(query)}" aria-label="Search"></form><details class="navwrap" open><summary>Pages</summary><nav class="tree">${navHtml || '<p class="muted">No pages yet</p>'}</nav></details><a class="side-link" href="/activity">Activity</a><a class="logout" href="/logout">Log out</a>`;
}

function breadcrumb(byId: Map<string, PageRow>, current: PageRow): string {
  const chain: PageRow[] = [];
  let c: PageRow | null = current;
  while (c) {
    chain.unshift(c);
    c = c.parent_id ? byId.get(c.parent_id) ?? null : null;
  }
  const parts = chain.map((p, i) =>
    i === chain.length - 1
      ? `<span>${esc(p.title)}</span>`
      : `<a href="${esc(fullPath(byId, p.id))}">${esc(p.title)}</a>`
  );
  return `<a href="/">Home</a><span class="sep">/</span>` + parts.join('<span class="sep">/</span>');
}

// --- revision / activity data + rendering ----------------------------------

interface RevRow {
  version: number;
  title: string;
  content_html: string;
  summary: string | null;
  created_at: string;
}

async function getRevision(env: Env, pageId: string, version: number): Promise<RevRow | null> {
  return await env.DB.prepare(
    `SELECT version, title, content_html, summary, created_at FROM revisions WHERE page_id = ? AND version = ?`
  )
    .bind(pageId, version)
    .first<RevRow>();
}

async function listRevisionRows(env: Env, pageId: string) {
  const { results } = await env.DB.prepare(
    `SELECT version, summary, created_at FROM revisions WHERE page_id = ? ORDER BY version DESC`
  )
    .bind(pageId)
    .all<{ version: number; summary: string | null; created_at: string }>();
  return results ?? [];
}

async function recentActivity(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT page_id, version, summary, created_at FROM revisions ORDER BY created_at DESC, version DESC LIMIT 50`
  ).all<{ page_id: string; version: number; summary: string | null; created_at: string }>();
  return results ?? [];
}

// Word/tag-level LCS diff; escapes everything so it renders as safe source.
function tokenizeForDiff(s: string): string[] {
  return s.match(/<[^>]+>|[^<\s]+|\s+/g) ?? [];
}

function diffHtml(oldStr: string, newStr: string): string {
  const a = tokenizeForDiff(oldStr);
  const b = tokenizeForDiff(newStr);
  const CAP = 3000;
  if (a.length > CAP || b.length > CAP) return esc("(content too large to diff inline)");
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  let out = "";
  while (i < n && j < m) {
    if (a[i] === b[j]) { out += esc(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out += `<del>${esc(a[i])}</del>`; i++; }
    else { out += `<ins>${esc(b[j])}</ins>`; j++; }
  }
  while (i < n) out += `<del>${esc(a[i++])}</del>`;
  while (j < m) out += `<ins>${esc(b[j++])}</ins>`;
  return out || esc("(no changes)");
}

function renderPageMain(
  byId: Map<string, PageRow>,
  childrenOf: Map<string | null, PageRow[]>,
  current: PageRow,
  cpath: string
): string {
  const kids = childrenOf.get(current.id) ?? [];
  let inner: string;
  if (current.content_html.trim()) {
    inner = `<div class="prose">${current.content_html}</div>`;
  } else if (kids.length) {
    inner = `<div class="prose"><p class="muted">This section has no content of its own.</p><ul class="index">${kids
      .map((p) => `<li><a href="${esc(fullPath(byId, p.id))}">${esc(p.title)}</a></li>`)
      .join("")}</ul></div>`;
  } else {
    inner = `<div class="prose"><p class="muted">This page is empty.</p></div>`;
  }
  const meta = `<footer class="meta">v${current.version} · updated ${esc(
    current.updated_at.slice(0, 10)
  )} · <a href="${esc(cpath)}?history=1">History</a></footer>`;
  return `<nav class="crumbs">${breadcrumb(byId, current)}</nav>${inner}${meta}`;
}

async function renderHistoryMain(
  env: Env,
  byId: Map<string, PageRow>,
  current: PageRow,
  cpath: string
): Promise<string> {
  const revs = await listRevisionRows(env, current.id);
  const currentRow = `<li><span class="badge">v${current.version}</span><span class="cur">current</span> · updated ${esc(
    current.updated_at.slice(0, 10)
  )}</li>`;
  const items = revs
    .map(
      (r) =>
        `<li><span class="badge">v${r.version}</span> ${esc(String(r.created_at).slice(0, 10))}${
          r.summary ? ` · ${esc(r.summary)}` : ""
        } · <a href="${esc(cpath)}?v=${r.version}">view</a> · <a href="${esc(cpath)}?diff=${r.version}">diff vs current</a></li>`
    )
    .join("");
  const body = revs.length
    ? `<ul class="history">${currentRow}${items}</ul>`
    : `<ul class="history">${currentRow}</ul><p class="muted">No earlier versions yet — edits will show up here.</p>`;
  return `<nav class="crumbs">${breadcrumb(byId, current)}<span class="sep">/</span><span>History</span></nav><div class="prose"><h1>History</h1><p class="muted">${esc(
    current.title
  )}</p></div>${body}<p style="margin-top:24px"><a href="${esc(cpath)}">← Back to page</a></p>`;
}

async function renderRevisionMain(
  env: Env,
  byId: Map<string, PageRow>,
  current: PageRow,
  cpath: string,
  v: number
): Promise<string> {
  const rev = await getRevision(env, current.id, v);
  const crumbs = `<nav class="crumbs">${breadcrumb(byId, current)}<span class="sep">/</span><span>v${v}</span></nav>`;
  if (!rev) return `${crumbs}<div class="prose"><p class="muted">No such revision.</p></div>`;
  const banner = `<div class="rev-banner">Viewing <strong>v${rev.version}</strong> from ${esc(
    String(rev.created_at).slice(0, 10)
  )} — an old version. <a href="${esc(cpath)}">Back to current</a> · <a href="${esc(cpath)}?diff=${v}">See diff</a></div>`;
  const content = rev.content_html.trim()
    ? `<div class="prose">${rev.content_html}</div>`
    : `<div class="prose"><p class="muted">(empty)</p></div>`;
  return `${crumbs}${banner}${content}`;
}

async function renderDiffMain(
  env: Env,
  byId: Map<string, PageRow>,
  current: PageRow,
  cpath: string,
  v: number
): Promise<string> {
  const rev = await getRevision(env, current.id, v);
  const crumbs = `<nav class="crumbs">${breadcrumb(byId, current)}<span class="sep">/</span><span>diff v${v}→v${current.version}</span></nav>`;
  if (!rev) return `${crumbs}<div class="prose"><p class="muted">No such revision.</p></div>`;
  const banner = `<div class="rev-banner">Diff: <strong>v${rev.version}</strong> → <strong>v${current.version}</strong> (current). <a href="${esc(
    cpath
  )}">Back to current</a></div>`;
  return `${crumbs}${banner}<pre class="diff">${diffHtml(rev.content_html, current.content_html)}</pre>`;
}

// A page is a full self-contained artifact if its HTML is a complete document.
// Those render isolated in an iframe so each page's own design fully controls it.
function isFullDoc(html: string): boolean {
  const s = html.slice(0, 400).toLowerCase();
  return s.includes("<!doctype") || /<html[\s>]/.test(s);
}

// Injected into every raw artifact: reports its content height to the parent
// reader so the (now isolated) iframe can be auto-sized without same-origin access.
const ARTIFACT_REPORTER =
  `<script>(function(){function h(){try{var y=Math.max(document.documentElement.scrollHeight,(document.body||{}).scrollHeight||0);if(y)parent.postMessage({__bnc_h:y},'*')}catch(e){}}addEventListener('load',h);try{new ResizeObserver(h).observe(document.documentElement)}catch(e){}setTimeout(h,300);setTimeout(h,1200);setInterval(h,2000)})();</script>`;

// Serve a page's raw document (for the artifact iframe). <base target="_top">
// makes links inside navigate the whole reader, not just the frame. `frameAncestors`
// restricts who may embed it (the reader origin only), and no script CSP is set so
// the artifact keeps full control of its own JS.
function rawArtifact(html: string, frameAncestors = "'self'"): Response {
  let out = html;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + '<base target="_top">');
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => m + '<head><base target="_top"></head>');
  else out = '<base target="_top">' + out;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, ARTIFACT_REPORTER + "</body>");
  else out = out + ARTIFACT_REPORTER;
  return new Response(out, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": `frame-ancestors ${frameAncestors}`,
    },
  });
}

function renderArtifactMain(
  byId: Map<string, PageRow>,
  current: PageRow,
  cpath: string,
  iframeTag: string
): string {
  const meta = `<footer class="meta">v${current.version} · updated ${esc(
    current.updated_at.slice(0, 10)
  )} · <a href="${esc(cpath)}?history=1">History</a></footer>`;
  return `<nav class="crumbs">${breadcrumb(byId, current)}</nav>${iframeTag}${meta}`;
}

async function handleReader(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(await hasValidSession(req, env)))
    return Response.redirect(new URL("/login", url).toString(), 302);

  const pages = await loadAllPages(env);
  const { byId, childrenOf } = buildIndex(pages);
  const path = decodeURIComponent(url.pathname);

  let current: PageRow | null = null;
  if (path !== "/") {
    current = resolvePath(pages, path);
    if (!current) {
      const nav = renderNav(childrenOf, byId, null, new Set(), null);
      return shellResponse(
        "Not found",
        renderSidebar(nav),
        `<nav class="crumbs"><a href="/">Home</a></nav><div class="prose"><h1>Not found</h1><p class="muted">No page at <code>${esc(path)}</code>.</p></div>`,
        404,
        env.RAW_ORIGIN
      );
    }
  }

  const activeIds = new Set<string>();
  if (current) {
    let c: PageRow | null = current;
    while (c) {
      activeIds.add(c.id);
      c = c.parent_id ? byId.get(c.parent_id) ?? null : null;
    }
  }
  const nav = renderNav(childrenOf, byId, null, activeIds, current?.id ?? null);

  let main: string;
  if (!current) {
    const roots = childrenOf.get(null) ?? [];
    const list = roots.length
      ? `<ul class="index">${roots
          .map((p) => `<li><a href="${esc(fullPath(byId, p.id))}">${esc(p.title)}</a></li>`)
          .join("")}</ul>`
      : `<p class="muted">No pages yet — create one with the MCP.</p>`;
    main = `<nav class="crumbs"><span>Home</span></nav><div class="prose"><h1>🧭 Binnacle</h1><p class="muted">A tree wiki. Pick a page from the sidebar.</p></div>${list}`;
  } else {
    const cpath = fullPath(byId, current.id);
    const sp = url.searchParams;
    // Same-origin raw path (fallback mode only). When RAW_ORIGIN is configured
    // the artifact is embedded from that separate origin instead, so refuse to
    // serve it here to keep the isolation boundary meaningful.
    if (sp.has("raw")) {
      if (env.RAW_ORIGIN) return new Response("Not Found", { status: 404 });
      return rawArtifact(current.content_html);
    }
    const vParam = sp.get("v");
    const diffParam = sp.get("diff");
    if (vParam && Number.isFinite(Number(vParam))) {
      main = await renderRevisionMain(env, byId, current, cpath, Number(vParam));
    } else if (diffParam && Number.isFinite(Number(diffParam))) {
      main = await renderDiffMain(env, byId, current, cpath, Number(diffParam));
    } else if (sp.has("history")) {
      main = await renderHistoryMain(env, byId, current, cpath);
    } else if (isFullDoc(current.content_html)) {
      main = renderArtifactMain(byId, current, cpath, await artifactIframe(env, current, cpath));
    } else {
      main = renderPageMain(byId, childrenOf, current, cpath);
    }
  }

  return shellResponse(current?.title ?? "Home", renderSidebar(nav), main, 200, env.RAW_ORIGIN);
}

// Build the <iframe> that hosts a full-document artifact. Cross-origin (RAW_ORIGIN)
// isolation keeps localStorage working; the same-origin fallback sandboxes the
// frame (scripts run, but no same-origin access — localStorage is disabled).
async function artifactIframe(env: Env, current: PageRow, cpath: string): Promise<string> {
  const title = esc(current.title);
  if (env.RAW_ORIGIN) {
    const t = await makeRawToken(env, cpath);
    const src = `${env.RAW_ORIGIN}${cpath}?raw=1&t=${encodeURIComponent(t)}`;
    return `<iframe class="artifact" src="${esc(src)}" title="${title}"></iframe>`;
  }
  return `<iframe class="artifact" src="${esc(cpath)}?raw=1" sandbox="allow-scripts allow-popups allow-forms allow-top-navigation-by-user-activation" title="${title}"></iframe>`;
}

async function handleSearch(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(await hasValidSession(req, env)))
    return Response.redirect(new URL("/login", url).toString(), 302);

  const q = (url.searchParams.get("q") ?? "").trim();
  const pages = await loadAllPages(env);
  const { byId, childrenOf } = buildIndex(pages);
  const nav = renderNav(childrenOf, byId, null, new Set(), null);
  const match = ftsQuery(q);

  let main: string;
  if (!q) {
    main = `<div class="prose"><h1>Search</h1><p class="muted">Type a query in the box above.</p></div>`;
  } else if (!match) {
    main = `<div class="prose"><h1>Search</h1><p class="muted">No searchable terms in “${esc(q)}”.</p></div>`;
  } else {
    //  /  delimit highlights; we escape the snippet then swap them for <mark>.
    const query = await env.DB.prepare(
      `SELECT page_id, title, snippet(pages_fts, 1, char(1), char(2), '…', 16) AS snip
       FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT 40`
    )
      .bind(match)
      .all<{ page_id: string; title: string; snip: string }>();
    const rows = (query.results ?? []).filter((r) => byId.has(r.page_id));
    const items = rows
      .map((r) => {
        const path = fullPath(byId, r.page_id);
        const snip = esc(String(r.snip ?? ""))
          .replaceAll("", "<mark>")
          .replaceAll("", "</mark>");
        return `<li><a href="${esc(path)}">${esc(r.title)}</a><div class="crumb-sm">${esc(path)}</div><p class="snip">${snip}</p></li>`;
      })
      .join("");
    main = `<div class="prose"><h1>Search</h1><p class="muted">${rows.length} result${
      rows.length === 1 ? "" : "s"
    } for “${esc(q)}”.</p></div><ul class="results">${
      items || '<li class="muted">Nothing found.</li>'
    }</ul>`;
  }

  return shellResponse("Search", renderSidebar(nav, q), main, 200, env.RAW_ORIGIN);
}

async function handleActivity(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(await hasValidSession(req, env)))
    return Response.redirect(new URL("/login", url).toString(), 302);
  const acts = await recentActivity(env);
  const pages = await loadAllPages(env);
  const { byId, childrenOf } = buildIndex(pages);
  const nav = renderNav(childrenOf, byId, null, new Set(), null);
  const items = acts
    .filter((a) => byId.has(a.page_id))
    .map((a) => {
      const p = byId.get(a.page_id)!;
      const path = fullPath(byId, p.id);
      const when = esc(String(a.created_at).slice(0, 16).replace("T", " "));
      return `<li><span class="badge">v${a.version}</span> ${when} · <a href="${esc(path)}">${esc(
        p.title
      )}</a>${a.summary ? ` — ${esc(a.summary)}` : ""}</li>`;
    })
    .join("");
  const main = `<div class="prose"><h1>Activity</h1><p class="muted">Recent edits across all pages. Each row is the version that was superseded.</p></div><ul class="history">${
    items || '<li class="muted">No activity yet.</li>'
  }</ul>`;
  return shellResponse("Activity", renderSidebar(nav), main, 200, env.RAW_ORIGIN);
}

function loginPage(error?: string): Response {
  const body = `<div class="login-wrap"><div class="login-card"><h1>🧭 Binnacle</h1><p class="muted">Enter your access token</p><form method="post" action="/login"><input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password"><button type="submit">Enter</button></form>${
    error ? `<p class="err">${esc(error)}</p>` : ""
  }</div></div>`;
  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Binnacle</title><style>${CSS}</style></head><body>${body}</body></html>`,
    error ? 401 : 200
  );
}

async function handleLoginPost(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  if (env.AUTH_TOKEN && (await digestEq(token, env.AUTH_TOKEN))) {
    return new Response(null, {
      status: 302,
      headers: { location: "/", "set-cookie": await makeSessionCookie(env) },
    });
  }
  return loginPage("Incorrect token.");
}

function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: "/login",
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    },
  });
}

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server
//
// Lets the Claude mobile app / claude.ai connect Binnacle as a Connector. It's
// fully self-contained — the "login" credential is AUTH_TOKEN. Access/refresh
// tokens are self-verifying HMACs (no token storage); only registered clients
// and one-time PKCE auth codes live in D1.
// ---------------------------------------------------------------------------

const ACCESS_TTL = 90 * 24 * 3600; // 90 days
const REFRESH_TTL = 365 * 24 * 3600; // 1 year
const CODE_TTL = 600; // 10 minutes

const OAUTH_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};
function ojson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...OAUTH_CORS, ...SECURITY_HEADERS },
  });
}

function b64url(buf: ArrayBuffer): string {
  const s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b.buffer);
}
async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", te.encode(s)));
}

async function makeOAuthToken(env: Env, kind: "at" | "rt", ttlSec: number): Promise<string> {
  const exp = Date.now() + ttlSec * 1000;
  return `${kind}.${exp}.${await hmacHex(env.AUTH_TOKEN, `${kind}.${exp}`)}`;
}
async function verifyOAuthToken(env: Env, kind: "at" | "rt", token: string | null): Promise<boolean> {
  if (!token) return false;
  const p = token.split(".");
  if (p.length !== 3 || p[0] !== kind) return false;
  const exp = Number(p[1]);
  if (!exp || exp < Date.now()) return false;
  return tokenMatches(p[2], await hmacHex(env.AUTH_TOKEN, `${kind}.${exp}`));
}

// Short-lived, path-scoped token that lets the cross-origin RAW_ORIGIN host serve
// one page's artifact without receiving the reader's session cookie. Only the
// authenticated reader can mint these (it holds AUTH_TOKEN via the HMAC key).
async function makeRawToken(env: Env, path: string): Promise<string> {
  const exp = Date.now() + 24 * 3600 * 1000;
  return `${exp}.${await hmacHex(env.AUTH_TOKEN, `raw.${path}.${exp}`)}`;
}
async function verifyRawToken(env: Env, path: string, token: string): Promise<boolean> {
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const exp = Number(token.slice(0, i));
  if (!exp || exp < Date.now()) return false;
  return tokenMatches(token.slice(i + 1), await hmacHex(env.AUTH_TOKEN, `raw.${path}.${exp}`));
}

// The RAW_ORIGIN host serves ONLY artifact documents, token-gated, embeddable
// solely by the reader origin. It exposes no reader/OAuth/MCP surface.
async function handleRawHost(req: Request, env: Env, url: URL): Promise<Response> {
  const path = decodeURIComponent(url.pathname);
  const token = url.searchParams.get("t") || "";
  if (!(await verifyRawToken(env, path, token)))
    return new Response("Forbidden", { status: 403, headers: SECURITY_HEADERS });
  const page = resolvePath(await loadAllPages(env), path);
  if (!page) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  return rawArtifact(page.content_html, env.READER_ORIGIN || "'self'");
}

// Static bearer token (Claude Code) OR an OAuth access token (the apps).
async function isAuthorizedMcp(env: Env, token: string | null): Promise<boolean> {
  if (!token || !env.AUTH_TOKEN) return false;
  if (await digestEq(token, env.AUTH_TOKEN)) return true;
  return verifyOAuthToken(env, "at", token);
}

async function issueTokens(env: Env) {
  return {
    access_token: await makeOAuthToken(env, "at", ACCESS_TTL),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: await makeOAuthToken(env, "rt", REFRESH_TTL),
    scope: "mcp",
  };
}

function oauthASMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}
function oauthPRMetadata(origin: string) {
  return { resource: `${origin}/mcp`, authorization_servers: [origin] };
}

async function getOAuthClient(env: Env, clientId: string) {
  return await env.DB.prepare(
    `SELECT client_id, redirect_uris, client_name FROM oauth_clients WHERE client_id = ?`
  )
    .bind(clientId)
    .first<{ client_id: string; redirect_uris: string; client_name: string | null }>();
}

async function handleRegister(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: OAUTH_CORS });
  let body: any = {};
  try { body = await req.json(); } catch {}
  const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirectUris.length)
    return ojson({ error: "invalid_client_metadata", error_description: "redirect_uris required" }, 400);
  const clientId = "client_" + randomToken(12);
  const name = typeof body.client_name === "string" ? body.client_name : null;
  await env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, redirect_uris, client_name) VALUES (?, ?, ?)`
  )
    .bind(clientId, JSON.stringify(redirectUris), name)
    .run();
  return ojson(
    {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: name,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201
  );
}

// Returns an error string, or null if the request is valid.
async function validateAuthzRequest(env: Env, q: URLSearchParams): Promise<string | null> {
  if (q.get("response_type") !== "code") return "response_type must be 'code'";
  if (q.get("code_challenge_method") !== "S256") return "PKCE with S256 is required";
  if (!q.get("code_challenge")) return "code_challenge is required";
  const client = await getOAuthClient(env, q.get("client_id") || "");
  if (!client) return "unknown client_id";
  let uris: string[] = [];
  try { uris = JSON.parse(client.redirect_uris); } catch {}
  if (!uris.includes(q.get("redirect_uri") || "")) return "redirect_uri is not registered";
  return null;
}

function renderAuthorizePage(q: URLSearchParams, appName: string, error?: string): Response {
  const hidden = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) || "")}">`)
    .join("");
  // Show where the authorization will be sent so the token holder can spot a
  // phishing client (open registration means any redirect_uri can be registered).
  let dest = "";
  try { dest = new URL(q.get("redirect_uri") || "").host; } catch {}
  const destLine = `<p class="muted" style="margin-top:14px">On approval you'll be redirected to <strong style="color:var(--fg)">${esc(
    dest || "an unrecognised address"
  )}</strong>. Only continue if you started this connection and trust that destination.</p>`;
  const body = `<div class="login-wrap"><div class="login-card"><h1>🧭 Binnacle</h1><p class="muted">${esc(
    appName
  )} wants to connect to your wiki. Enter your access token to allow it.</p>${destLine}<form method="post" action="/authorize">${hidden}<input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password"><button type="submit">Allow access</button></form>${
    error ? `<p class="err">${esc(error)}</p>` : ""
  }</div></div>`;
  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize · Binnacle</title><style>${CSS}</style></head><body>${body}</body></html>`,
    error ? 401 : 200
  );
}

function oauthErrorPage(msg: string): Response {
  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorization error · Binnacle</title><style>${CSS}</style></head><body><div class="login-wrap"><div class="login-card"><h1>🧭 Binnacle</h1><p class="err">Authorization error: ${esc(
      msg
    )}</p></div></div></body></html>`,
    400
  );
}

async function handleAuthorizeGet(req: Request, env: Env, url: URL): Promise<Response> {
  const q = url.searchParams;
  const err = await validateAuthzRequest(env, q);
  if (err) return oauthErrorPage(err);
  const client = await getOAuthClient(env, q.get("client_id") || "");
  return renderAuthorizePage(q, client?.client_name || "An application");
}

async function handleAuthorizePost(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const q = new URLSearchParams();
  for (const k of ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"])
    q.set(k, String(form.get(k) || ""));
  const err = await validateAuthzRequest(env, q);
  if (err) return oauthErrorPage(err);

  const token = String(form.get("token") || "");
  if (!(env.AUTH_TOKEN && (await digestEq(token, env.AUTH_TOKEN)))) {
    const client = await getOAuthClient(env, q.get("client_id") || "");
    return renderAuthorizePage(q, client?.client_name || "An application", "Incorrect token.");
  }

  const code = randomToken(24);
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(code, q.get("client_id"), q.get("redirect_uri"), q.get("code_challenge"), Date.now() + CODE_TTL * 1000)
    .run();

  const redirect = new URL(q.get("redirect_uri")!);
  redirect.searchParams.set("code", code);
  if (q.get("state")) redirect.searchParams.set("state", q.get("state")!);
  return new Response(null, { status: 302, headers: { location: redirect.toString() } });
}

async function handleToken(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: OAUTH_CORS });
  const form = await req.formData();
  const grant = String(form.get("grant_type") || "");

  if (grant === "authorization_code") {
    const code = String(form.get("code") || "");
    const row = await env.DB.prepare(
      `SELECT client_id, redirect_uri, code_challenge, expires_at FROM oauth_codes WHERE code = ?`
    )
      .bind(code)
      .first<{ client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }>();
    if (row) await env.DB.prepare(`DELETE FROM oauth_codes WHERE code = ?`).bind(code).run(); // one-time
    if (!row || row.expires_at < Date.now()) return ojson({ error: "invalid_grant" }, 400);
    if (row.redirect_uri !== String(form.get("redirect_uri") || ""))
      return ojson({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    const verifier = String(form.get("code_verifier") || "");
    if (!verifier || (await sha256b64url(verifier)) !== row.code_challenge)
      return ojson({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    return ojson(await issueTokens(env));
  }

  if (grant === "refresh_token") {
    if (!(await verifyOAuthToken(env, "rt", String(form.get("refresh_token") || ""))))
      return ojson({ error: "invalid_grant" }, 400);
    return ojson(await issueTokens(env));
  }

  return ojson({ error: "unsupported_grant_type" }, 400);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // Isolated artifact origin: serves only token-gated artifact documents.
    if (env.RAW_ORIGIN && url.origin === env.RAW_ORIGIN) return handleRawHost(req, env, url);

    if (p === "/mcp") return handleMcp(req, env, url);
    if (p === "/health") return json({ ok: true, service: SERVER_INFO });

    // OAuth discovery + endpoints (public)
    if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration"))
      return ojson(oauthASMetadata(url.origin));
    if (p.startsWith("/.well-known/oauth-protected-resource")) return ojson(oauthPRMetadata(url.origin));
    if (p === "/register") return handleRegister(req, env);
    if (p === "/authorize") return req.method === "POST" ? handleAuthorizePost(req, env) : handleAuthorizeGet(req, env, url);
    if (p === "/token") return handleToken(req, env);

    // Web reader
    if (p === "/login") return req.method === "POST" ? handleLoginPost(req, env) : loginPage();
    if (p === "/logout") return handleLogout();
    if (p === "/search") return handleSearch(req, env, url);
    if (p === "/activity") return handleActivity(req, env, url);
    return handleReader(req, env, url);
  },
};
