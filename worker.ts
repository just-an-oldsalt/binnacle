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
// Reader (stub — Phase 2)
// ---------------------------------------------------------------------------

function readerStub(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Binnacle</title>
     <body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222">
     <h1>🧭 Binnacle</h1>
     <p>The MCP is live at <code>/mcp</code>. The web reader lands in Phase 2.</p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return handleMcp(req, env, url);
    if (url.pathname === "/health") return json({ ok: true, service: SERVER_INFO });
    return readerStub();
  },
};
