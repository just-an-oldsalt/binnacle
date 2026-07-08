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
  if (!token || !env.AUTH_TOKEN || !tokenMatches(token, env.AUTH_TOKEN))
    return json(rpcError(null, -32001, "unauthorized"), 401);

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

function renderSidebar(navHtml: string): string {
  return `<a class="brand" href="/">🧭 Binnacle</a><details class="navwrap" open><summary>Pages</summary><nav class="tree">${navHtml || '<p class="muted">No pages yet</p>'}</nav></details><a class="logout" href="/logout">Log out</a>`;
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
    const meta = `<footer class="meta">v${current.version} · updated ${esc(current.updated_at.slice(0, 10))}</footer>`;
    main = `<nav class="crumbs">${breadcrumb(byId, current)}</nav>${inner}${meta}`;
  }

  return htmlResponse(pageShell(current?.title ?? "Home", renderSidebar(nav), main));
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
// Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return handleMcp(req, env, url);
    if (url.pathname === "/health") return json({ ok: true, service: SERVER_INFO });
    if (url.pathname === "/login")
      return req.method === "POST" ? handleLoginPost(req, env) : loginPage();
    if (url.pathname === "/logout") return handleLogout();
    return handleReader(req, env, url);
  },
};
