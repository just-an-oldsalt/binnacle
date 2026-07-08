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
}

const MAX_REVISIONS = 20;
const SERVER_INFO = { name: "binnacle", version: "0.1.0" };
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
    headers: { "content-type": "application/json", ...CORS, ...extraHeaders },
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

// Constant-time-ish comparison.
function tokenMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
      "Create a page. `title` required. Optional `parent_id` (omit for top-level), `slug` (auto from title), `content_html` (raw HTML body fragment), `sort_order`.",
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
      "Update a page's `title` and/or `content_html`. The previous state is snapshotted to history. Pass a short `summary` describing the change.",
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

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

const CSS = `
:root{--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;--sidebar-bg:#fafafa;--accent:#2563eb;--code-bg:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--muted:#9ca3af;--border:#242832;--sidebar-bg:#0b0d11;--accent:#7aa2f7;--code-bg:#1a1d24}}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);display:flex;min-height:100vh;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.muted{color:var(--muted)}
.sidebar{width:272px;flex-shrink:0;background:var(--sidebar-bg);border-right:1px solid var(--border);padding:20px 16px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:block;font-weight:600;font-size:1.05rem;color:var(--fg);margin-bottom:16px}.brand:hover{text-decoration:none}
.navwrap>summary{display:none}
.tree ul{list-style:none;margin:0;padding-left:14px}.tree>nav>ul,.tree>ul{padding-left:0}.tree li{margin:1px 0}
.nav-link{display:block;padding:3px 8px;border-radius:6px;color:var(--fg);font-size:.92rem}
.nav-link:hover{background:var(--code-bg);text-decoration:none}.nav-link.active{background:var(--accent);color:#fff;font-weight:500}
.tree details>summary{list-style:none;cursor:pointer;display:flex;align-items:center}
.tree details>summary::-webkit-details-marker{display:none}
.tree details>summary::before{content:"\\25B8";color:var(--muted);font-size:.7rem;margin-right:2px;transition:transform .1s;display:inline-block;width:12px}
.tree details[open]>summary::before{transform:rotate(90deg)}
.tree details>summary .nav-link{flex:1}
.logout{display:block;margin-top:20px;font-size:.85rem;color:var(--muted)}
.content{flex:1;min-width:0;display:flex;justify-content:center;padding:40px 32px}
.content article{width:100%;max-width:760px}
.crumbs{font-size:.85rem;color:var(--muted);margin-bottom:20px}.crumbs a{color:var(--muted)}.crumbs .sep{margin:0 6px;opacity:.5}
.prose{font-size:1rem}
.prose h1{font-size:1.9rem;line-height:1.2;margin:.2em 0 .6em}
.prose h2{font-size:1.4rem;margin:1.6em 0 .5em;padding-bottom:.2em;border-bottom:1px solid var(--border)}
.prose h3{font-size:1.15rem;margin:1.4em 0 .4em}
.prose p{margin:.8em 0}.prose ul,.prose ol{padding-left:1.4em;margin:.8em 0}.prose li{margin:.25em 0}
.prose code{background:var(--code-bg);padding:.15em .4em;border-radius:4px;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.prose pre{background:var(--code-bg);padding:14px 16px;border-radius:8px;overflow-x:auto;margin:1em 0}.prose pre code{background:none;padding:0}
.prose blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid var(--border);color:var(--muted)}
.prose table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92rem;display:block;overflow-x:auto}
.prose th,.prose td{border:1px solid var(--border);padding:7px 11px;text-align:left}.prose th{background:var(--code-bg)}
.prose img{max-width:100%;height:auto}.prose a{text-decoration:underline}.prose hr{border:none;border-top:1px solid var(--border);margin:2em 0}
.index{list-style:none;padding-left:0}.index li{margin:.4em 0}.index a{font-weight:500}
.meta{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);font-size:.82rem;color:var(--muted)}
.search{margin-bottom:14px}
.search input{width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font-size:.9rem}
.results{list-style:none;padding-left:0}.results li{margin:0 0 20px}
.results>li>a{font-weight:600;font-size:1.05rem}
.results .crumb-sm{font-size:.78rem;color:var(--muted);margin:2px 0}
.results .snip{margin:.3em 0 0;font-size:.92rem;color:var(--fg)}
.results mark{background:var(--accent);color:#fff;padding:0 2px;border-radius:3px}
.side-link{display:block;margin-top:14px;font-size:.85rem;color:var(--muted)}
.rev-banner{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:.9rem;margin-bottom:22px}
.history{list-style:none;padding-left:0}
.history li{padding:8px 0;border-bottom:1px solid var(--border);font-size:.92rem}
.badge{display:inline-block;background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:0 6px;font-size:.76rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-right:6px}
.history .cur{color:var(--accent);font-weight:600;margin-right:4px}
pre.diff{background:var(--code-bg);padding:14px 16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-size:.85rem;line-height:1.7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre.diff del{background:rgba(220,38,38,.18);color:#e5484d;text-decoration:line-through}
pre.diff ins{background:rgba(22,163,74,.20);color:#2fa84f;text-decoration:none}
.login-wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.login-card{width:100%;max-width:360px;text-align:center}.login-card h1{font-size:1.5rem;margin-bottom:8px}
.login-card form{margin-top:20px;display:flex;flex-direction:column;gap:12px}
.login-card input{padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font-size:1rem}
.login-card button{padding:10px 12px;border:none;border-radius:8px;background:var(--accent);color:#fff;font-size:1rem;font-weight:500;cursor:pointer}
.login-card .err{color:#dc2626;font-size:.9rem;margin-top:10px}
@media (max-width:720px){body{flex-direction:column}.sidebar{width:auto;height:auto;position:static;border-right:none;border-bottom:1px solid var(--border)}.navwrap>summary{display:block;cursor:pointer;font-size:.9rem;color:var(--muted);padding:4px 0}.content{padding:24px 18px}}
`;

function pageShell(title: string, sidebar: string, main: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Binnacle</title><style>${CSS}</style></head><body><aside class="sidebar">${sidebar}</aside><main class="content"><article>${main}</article></main></body></html>`;
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
      return htmlResponse(
        pageShell(
          "Not found",
          renderSidebar(nav),
          `<nav class="crumbs"><a href="/">Home</a></nav><div class="prose"><h1>Not found</h1><p class="muted">No page at <code>${esc(path)}</code>.</p></div>`
        ),
        404
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
    const vParam = sp.get("v");
    const diffParam = sp.get("diff");
    if (vParam && Number.isFinite(Number(vParam))) {
      main = await renderRevisionMain(env, byId, current, cpath, Number(vParam));
    } else if (diffParam && Number.isFinite(Number(diffParam))) {
      main = await renderDiffMain(env, byId, current, cpath, Number(diffParam));
    } else if (sp.has("history")) {
      main = await renderHistoryMain(env, byId, current, cpath);
    } else {
      main = renderPageMain(byId, childrenOf, current, cpath);
    }
  }

  return htmlResponse(pageShell(current?.title ?? "Home", renderSidebar(nav), main));
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

  return htmlResponse(pageShell("Search", renderSidebar(nav, q), main));
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
  return htmlResponse(pageShell("Activity", renderSidebar(nav), main));
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
  if (env.AUTH_TOKEN && token.length === env.AUTH_TOKEN.length && tokenMatches(token, env.AUTH_TOKEN)) {
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
    headers: { "content-type": "application/json", ...OAUTH_CORS },
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

// Static bearer token (Claude Code) OR an OAuth access token (the apps).
async function isAuthorizedMcp(env: Env, token: string | null): Promise<boolean> {
  if (!token || !env.AUTH_TOKEN) return false;
  if (token.length === env.AUTH_TOKEN.length && tokenMatches(token, env.AUTH_TOKEN)) return true;
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
  const body = `<div class="login-wrap"><div class="login-card"><h1>🧭 Binnacle</h1><p class="muted">${esc(
    appName
  )} wants to connect to your wiki. Enter your access token to allow it.</p><form method="post" action="/authorize">${hidden}<input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password"><button type="submit">Allow access</button></form>${
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
  if (!(env.AUTH_TOKEN && token.length === env.AUTH_TOKEN.length && tokenMatches(token, env.AUTH_TOKEN))) {
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
