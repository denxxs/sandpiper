// Sandpiper — a self-hosted, real-time collaborative workspace.
// Copyright (C) 2026 Dennis Sagayanathan
//
// This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero
// General Public License as published by the Free Software Foundation, version 3.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
// License for more details.
//
// You should have received a copy of the GNU Affero General Public License along with this program. If not, see
// <https://www.gnu.org/licenses/>.

// Sandpiper on Cloudflare: one Worker plus four SQLite-backed Durable Object classes.
//
//   YDocRoom     one per document (a workspace's page tree, or one page; names in worker/rooms.ts):
//                live sync over WebSocket (y-websocket wire protocol) and durable storage of the document
//   SearchIndex  one per workspace, holding the plain text of its pages, for search
//   FileStore    one per uploaded file
//   AuthStore    accounts, sessions, passkeys, members and workspaces (worker/auth.ts)
//
// The built web app in dist/ is served by Workers static assets; /api, /auth, /collab and
// /uploads reach the Worker (worker/app.ts), which checks the session and workspace first.
import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { roomPageId, roomWorkspace, searchName, WS_ID_RE } from "./rooms";
import { treeOp, type TreeCtx } from "./mcp/tree";

/** Marks document changes made through MCP (they're broadcast to every open connection). */
const MCP_ORIGIN = "mcp";
const MCP_CLIENT_ID = 0x5a4e55;
/** Operations that only read, run on the document directly. */
const MCP_READS = new Set(["snapshot", "has", "subtree", "read", "text", "threads"]);

export interface Env {
  DOCS: DurableObjectNamespace<YDocRoom>;
  SEARCH: DurableObjectNamespace<SearchIndex>;
  FILES: DurableObjectNamespace<FileStore>;
  AUTH: DurableObjectNamespace<import("./auth").AuthStore>;
  ASSETS: Fetcher;
  /** OAuth client ID from Google Cloud (public). */
  GOOGLE_CLIENT_ID?: string;
  /** OAuth client secret, set with `npx wrangler secret put GOOGLE_CLIENT_SECRET`. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Members created the first time the app runs: "email:owner,email:member". */
  INITIAL_MEMBERS?: string;
  /** "1" only under `npm run dev`: trusts the dev server's forwarded host. Never set in production. */
  LOCAL_DEV?: string;
  /** Local tests only: a stand-in for Google, honoured only when LOCAL_DEV is "1". */
  OAUTH_MOCK_URL?: string;
}

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
const CHUNK = 1024 * 1024; // stored blob size; the platform limit is 8 MB per value
const MAX_UPLOAD = 25 * 1024 * 1024;
const COMPACT_AFTER = 200; // incremental updates kept before folding them into one snapshot

// ================================================================ document room

interface Attachment {
  /** awareness client id -> last clock seen, so we can announce their departure */
  c: Record<string, number>;
  /** hash of the session this socket was opened with, and its user */
  s?: string;
  u?: string;
  /** when the session was last confirmed valid */
  t?: number;
}

/** How often an open connection re-checks that its session is still valid. */
const SESSION_RECHECK_MS = 5 * 60_000;

export class YDocRoom extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private pending = 0;
  private indexQueued = false;

  private schema() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER NOT NULL, data BLOB NOT NULL)",
    );
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  /** Loads the document from storage the first time it's needed after a wake-up. */
  private getDoc(): Y.Doc {
    if (this.doc) return this.doc;
    this.schema();
    const doc = new Y.Doc();
    const snapshot: Uint8Array[] = [];
    const updates: Uint8Array[] = [];
    for (const row of this.ctx.storage.sql.exec("SELECT kind, data FROM chunks ORDER BY id")) {
      const bytes = new Uint8Array(row.data as ArrayBuffer);
      if (row.kind === 0) snapshot.push(bytes);
      else updates.push(bytes);
    }
    if (snapshot.length) Y.applyUpdate(doc, concat(snapshot), "load");
    for (const u of updates) Y.applyUpdate(doc, u, "load");
    this.pending = updates.length;

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "load") return;
      this.persist(update);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin as WebSocket);
      this.queueIndex();
    });
    this.doc = doc;
    return doc;
  }

  private persist(update: Uint8Array) {
    if (update.byteLength > CHUNK || this.pending >= COMPACT_AFTER) return this.compact();
    this.ctx.storage.sql.exec("INSERT INTO chunks (kind, data) VALUES (1, ?)", update);
    this.pending++;
  }

  /** Replaces everything stored with a single snapshot of the current document. */
  private compact() {
    const state = Y.encodeStateAsUpdate(this.doc!);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM chunks");
      for (let i = 0; i < state.byteLength || i === 0; i += CHUNK) {
        this.ctx.storage.sql.exec("INSERT INTO chunks (kind, data) VALUES (0, ?)", state.subarray(i, i + CHUNK));
      }
    });
    this.pending = 0;
  }

  private room(): string {
    const row = this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k = 'room'").toArray()[0];
    return row ? String(row.v) : "";
  }

  private queueIndex() {
    if (this.indexQueued) return;
    this.indexQueued = true;
    // An alarm (unlike a timer) lets the object sleep in the meantime.
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 8000));
  }

  async alarm() {
    this.indexQueued = false;
    const room = this.room();
    const ws = roomWorkspace(room);
    const pageId = roomPageId(room);
    if (!ws || !pageId) return;
    const text = docText(this.getDoc());
    await this.env.SEARCH.get(this.env.SEARCH.idFromName(searchName(ws))).setText(pageId, text);
  }

  private broadcast(msg: Uint8Array, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        /* socket is closing */
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = url.pathname.split("/").pop() ?? "";
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });

    const doc = this.getDoc();
    if (!this.room()) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('room', ?)", room);

    // Set by the Worker after it checked the session cookie; anything sent by the browser is replaced.
    const session = request.headers.get("X-Sandpiper-Session") ?? "";
    const userId = request.headers.get("X-Sandpiper-User") ?? "";
    if (!session) return new Response("Not signed in", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ c: {}, s: session, u: userId, t: Date.now() } satisfies Attachment);
    // Lets the account store disconnect this socket when the person is removed or signed out.
    this.ctx.waitUntil(this.env.AUTH.get(this.env.AUTH.idFromName("auth")).registerSocket(room, session, userId).catch(() => {}));

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    server.send(encoding.toUint8Array(encoder));

    // Ask everyone already here to re-announce their cursor/presence for the newcomer.
    const query = encoding.createEncoder();
    encoding.writeVarUint(query, MSG_QUERY_AWARENESS);
    this.broadcast(encoding.toUint8Array(query), server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Closes this room's sockets that belong to the given sessions. */
  async kick(sessions: string[]) {
    const set = new Set(sessions);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.s && set.has(att.s)) {
        this.departed(ws);
        try {
          ws.close(4401, "signed out");
        } catch {
          /* already closed */
        }
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === "string") return;
    // Long-lived connections re-check their session now and then (expiry, removal, sign-out, taken out of the workspace).
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.s) return ws.close(4401, "signed out");
    if (Date.now() - (att.t ?? 0) > SESSION_RECHECK_MS) {
      const valid = await this.env.AUTH.get(this.env.AUTH.idFromName("auth")).sessionValid(att.s, this.room());
      if (!valid) {
        this.departed(ws);
        return ws.close(4401, "signed out");
      }
      att.t = Date.now();
      ws.serializeAttachment(att);
    }
    try {
      const data = new Uint8Array(message);
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, this.getDoc(), ws);
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      } else if (type === MSG_AWARENESS) {
        // Presence isn't stored: remember which clients belong to this socket, then relay.
        const att = (ws.deserializeAttachment() as Attachment | null) ?? { c: {} };
        const d = decoding.createDecoder(decoding.readVarUint8Array(decoder));
        const n = decoding.readVarUint(d);
        for (let i = 0; i < n; i++) {
          const id = decoding.readVarUint(d);
          const clock = decoding.readVarUint(d);
          const state = decoding.readVarString(d);
          if (state === "null") delete att.c[id];
          else att.c[id] = clock;
        }
        if (Object.keys(att.c).length <= 64) ws.serializeAttachment(att);
        // Echo to everyone, the sender included: the client drops and reconnects a connection that hears nothing
        // for 30 s, and its own presence heartbeat (every 15 s) is what keeps a lone person's connection alive.
        this.broadcast(data);
      } else if (type === MSG_QUERY_AWARENESS) {
        this.broadcast(data, ws);
      }
    } catch (err) {
      console.error("bad message", err);
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    this.departed(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      /* already closed */
    }
  }
  webSocketError(ws: WebSocket) {
    this.departed(ws);
  }

  /** Tells the remaining clients that this socket's cursors are gone. */
  private departed(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    const ids = Object.keys(att?.c ?? {});
    if (!ids.length) return;
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, ids.length);
    for (const id of ids) {
      encoding.writeVarUint(inner, Number(id));
      encoding.writeVarUint(inner, att!.c[id] + 1);
      encoding.writeVarString(inner, "null");
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, encoding.toUint8Array(inner));
    this.broadcast(encoding.toUint8Array(encoder), ws);
  }

  // ---- called by the Worker (RPC)

  async getState(): Promise<Uint8Array> {
    return Y.encodeStateAsUpdate(this.getDoc());
  }
  /** For a workspace's page-tree room: the ids of every page in it (used when the workspace is deleted). */
  async pageIds(): Promise<string[]> {
    return [...this.getDoc().getMap("pages").keys()];
  }
  /** Fills a brand-new document with a copy of another. Returns false if it already has content. */
  async putState(room: string, state: Uint8Array): Promise<boolean> {
    this.getDoc();
    if (this.ctx.storage.sql.exec("SELECT 1 FROM chunks LIMIT 1").toArray().length) return false;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('room', ?)", room);
    Y.applyUpdate(this.doc!, state, "copy");
    return true;
  }
  /**
   * Runs one MCP operation on this document, atomically: on a workspace's page tree ("tree") or on a page's
   * content and comments ("content"). Changes reach everyone with the document open, like any other edit.
   */
  async run(room: string, area: "tree" | "content", op: string, args: unknown, ctx: TreeCtx): Promise<unknown> {
    const isPage = !!roomPageId(room);
    if (!roomWorkspace(room) || isPage !== (area === "content")) throw new Error("bad room");
    const doc = this.getDoc();
    // A page made through MCP may never have been opened in the app; name the room so search indexes it.
    if (!this.room()) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('room', ?)", room);
    // The page-content engine (BlockNote) loads only when an MCP edit first needs it, so it never slows the app's
    // own requests.
    const contentOp = area === "content" ? (await import("./mcp/content")).contentOp : null;
    const exec = (d: Y.Doc) => (contentOp ? contentOp(d, op, args, ctx) : treeOp(d, op, args, ctx));
    if (MCP_READS.has(op)) return await exec(doc);

    // All or nothing: the change is made on a copy, and only a change that finished is applied to the real document,
    // as one update. Yjs can't undo half a change, and some operations touch many things.
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    // One stable writer id for MCP edits in every document, set after loading so Yjs sees its edits as its own.
    scratch.clientID = MCP_CLIENT_ID;
    const updates: Uint8Array[] = [];
    scratch.on("update", (u: Uint8Array) => updates.push(u));
    try {
      const result = await exec(scratch);
      if (updates.length) Y.applyUpdate(doc, Y.mergeUpdates(updates), MCP_ORIGIN);
      return result;
    } finally {
      scratch.destroy();
    }
  }

  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "deleted");
      } catch {
        /* ignore */
      }
    }
    this.doc?.destroy();
    this.doc = null;
    this.pending = 0;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function docText(doc: Y.Doc): string {
  return doc
    .getXmlFragment("content")
    .toString()
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ================================================================ search index

export class SearchIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
  }
  async setText(id: string, text: string) {
    const cur = this.ctx.storage.sql.exec("SELECT text FROM pages WHERE id = ?", id).toArray()[0];
    if (cur && cur.text === text) return;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO pages (id, text) VALUES (?, ?)", id, text.slice(0, 500_000));
  }
  async remove(id: string) {
    this.ctx.storage.sql.exec("DELETE FROM pages WHERE id = ?", id);
  }
  async clear() {
    this.ctx.storage.sql.exec("DELETE FROM pages");
  }
  async search(query: string): Promise<{ pageId: string; snippet: string }[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { pageId: string; snippet: string }[] = [];
    for (const row of this.ctx.storage.sql.exec("SELECT id, text FROM pages WHERE instr(lower(text), ?) > 0 LIMIT 40", q)) {
      const text = String(row.text);
      const at = Math.max(0, text.toLowerCase().indexOf(q));
      const start = Math.max(0, at - 40);
      const end = at + q.length + 80;
      out.push({ pageId: String(row.id), snippet: (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "") });
    }
    return out;
  }
}

// ================================================================ uploaded files

export class FileStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS parts (i INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }
  async fetch(request: Request): Promise<Response> {
    const sql = this.ctx.storage.sql;
    if (request.method === "PUT") {
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > MAX_UPLOAD) return new Response("too large", { status: 413 });
      const ws = request.headers.get("X-Sandpiper-Ws") ?? "";
      this.ctx.storage.transactionSync(() => {
        sql.exec("DELETE FROM parts");
        for (let i = 0, n = 0; i < body.byteLength; i += CHUNK * 4, n++) {
          sql.exec("INSERT INTO parts (i, data) VALUES (?, ?)", n, body.subarray(i, i + CHUNK * 4));
        }
        if (WS_ID_RE.test(ws)) sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('ws', ?)", ws);
      });
      return new Response(null, { status: 204 });
    }
    const parts: Uint8Array[] = [];
    for (const row of sql.exec("SELECT data FROM parts ORDER BY i")) parts.push(new Uint8Array(row.data as ArrayBuffer));
    if (!parts.length) return new Response("not found", { status: 404 });
    // Which workspace the file was added to; files from before workspaces existed belong to the original one.
    const ws = sql.exec("SELECT v FROM meta WHERE k = 'ws'").toArray()[0]?.v ?? "main";
    return new Response(concat(parts), { headers: { "X-Sandpiper-Ws": String(ws) } });
  }
}

// ================================================================ exports

export { AuthStore } from "./auth";
export { default } from "./app";
