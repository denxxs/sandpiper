// Accounts, sessions, passkeys, the member list and workspaces, in one SQLite-backed Durable Object.
//
// Sign-in methods:
//   - Google (the account is matched by email; only emails on the member list get in)
//   - passkeys, which a signed-in member adds from Settings (as many as they like)
//
// Sessions are random tokens kept in an HttpOnly cookie; only their SHA-256 hash is stored.
//
// Members are the people who can sign in at all. Each workspace then has its own list of who can open it,
// so a workspace with only its creator in it is private to them: nobody else, the app owner included, gets in.
import { DurableObject } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { roomWorkspace, WS_ID_RE } from "./rooms";

export type Role = "owner" | "member";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  color: string;
  avatar: string | null;
  role: Role;
}

export interface Member {
  email: string;
  role: Role;
  addedAt: number;
  user: { id: string; name: string; color: string; avatar: string | null; lastSeen: number | null; passkeys: number } | null;
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsed: number | null;
  synced: boolean;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeen: number;
  agent: string;
  method: string;
}

export interface Workspace {
  id: string;
  name: string | null;
  icon: string | null;
  /** Email of the person who manages it: who's in it, and deleting it. */
  owner: string;
  isOwner: boolean;
  createdAt: number;
  members: { email: string; user: { id: string; name: string; color: string; avatar: string | null } | null }[];
}

/** A generous ceiling so a stuck client can't create workspaces without end. */
const MAX_OWNED_WORKSPACES = 50;

interface AuthEnv {
  INITIAL_MEMBERS?: string;
  /** Document rooms, so open live connections can be closed on sign-out or removal. */
  DOCS: DurableObjectNamespace<{ kick(sessions: string[]): Promise<void> } & Rpc.DurableObjectBranded>;
}

export const SESSION_DAYS = 60;
const SESSION_MS = SESSION_DAYS * 86400_000;
const CHALLENGE_MS = 5 * 60_000;
// Same palette as the client's colour picker.
export const USER_COLORS = ["#3b5bdb", "#0c8599", "#7048e8", "#c2255c", "#e8590c", "#5f3dc4", "#1971c2", "#a61e4d", "#d9480f", "#087f5b"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const enc = new TextEncoder();
import { USER_ERROR } from "./errors";
export { USER_ERROR };
const userError = (message: string) => new Error(USER_ERROR + message);

function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomId(length = 9): string {
  const a = crypto.getRandomValues(new Uint8Array(length));
  let s = "";
  for (const b of a) s += "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36];
  return s;
}
async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export class AuthStore extends DurableObject<AuthEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AuthEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (email TEXT PRIMARY KEY, role TEXT NOT NULL, added_by TEXT, added_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, google_sub TEXT, name TEXT NOT NULL, color TEXT NOT NULL,
        avatar TEXT, created_at INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL, agent TEXT, method TEXT);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT,
        name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, synced INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sockets (room TEXT NOT NULL, session TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (room, session));
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT, icon TEXT, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_members (ws TEXT NOT NULL, email TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (ws, email));
      CREATE INDEX IF NOT EXISTS workspace_members_email ON workspace_members(email);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, uri TEXT, redirect_uris TEXT NOT NULL, auth_method TEXT NOT NULL,
        secret_hash TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT, challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes (
        hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ai_grants (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, client_id TEXT, name TEXT NOT NULL, access TEXT NOT NULL,
        workspaces TEXT, created_at INTEGER NOT NULL, last_used INTEGER);
      CREATE INDEX IF NOT EXISTS ai_grants_user ON ai_grants(user_id);
      CREATE TABLE IF NOT EXISTS ai_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_tokens_grant ON ai_tokens(grant_id);
    `);
    this.seedMembers();
    this.seedWorkspaces();
  }

  /**
   * Once, when workspaces arrive: the workspace that already exists becomes "main", managed by the owner and open to
   * everyone who could sign in before. It keeps its documents exactly where they were.
   */
  private seedWorkspaces() {
    if (this.sql.exec("SELECT 1 FROM kv WHERE k = 'workspaces_seeded'").toArray().length) return;
    const members = this.sql.exec("SELECT email, role FROM members ORDER BY role = 'owner' DESC, added_at").toArray();
    if (!members.length) return;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT OR IGNORE INTO workspaces (id, name, icon, owner, created_at) VALUES ('main', NULL, NULL, ?, ?)", String(members[0].email), now);
      for (const m of members) this.sql.exec("INSERT OR IGNORE INTO workspace_members (ws, email, added_at) VALUES ('main', ?, ?)", String(m.email), now);
      this.sql.exec("INSERT INTO kv (k, v) VALUES ('workspaces_seeded', '1')");
    });
  }

  /** The very first time, the member list comes from INITIAL_MEMBERS ("a@x.com:owner,b@y.com:member"). */
  private seedMembers() {
    if (this.sql.exec("SELECT COUNT(*) AS n FROM members").one().n) return;
    for (const part of (this.env.INITIAL_MEMBERS ?? "").split(",")) {
      const [rawEmail, rawRole] = part.split(":");
      const email = clean(rawEmail, 254).toLowerCase();
      if (!EMAIL_RE.test(email)) continue;
      const role: Role = rawRole?.trim() === "owner" ? "owner" : "member";
      this.sql.exec("INSERT OR IGNORE INTO members (email, role, added_by, added_at) VALUES (?, ?, 'setup', ?)", email, role, Date.now());
    }
  }

  // ---------------------------------------------------------------- helpers

  private user(id: string): AuthUser | null {
    const r = this.sql
      .exec(
        "SELECT u.id, u.email, u.name, u.color, u.avatar, m.role FROM users u JOIN members m ON m.email = u.email WHERE u.id = ?",
        id,
      )
      .toArray()[0];
    return r ? this.toUser(r) : null;
  }
  private toUser(r: Record<string, SqlStorageValue>): AuthUser {
    return {
      id: String(r.id),
      email: String(r.email),
      name: String(r.name),
      color: String(r.color),
      avatar: r.avatar ? String(r.avatar) : null,
      role: r.role === "owner" ? "owner" : "member",
    };
  }
  private requireOwner(actorId: string) {
    if (this.user(actorId)?.role !== "owner") throw userError("Only the owner of Sandpiper can do that.");
  }
  private async newSession(userId: string, agent: string, method: string): Promise<string> {
    const token = randomToken();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO sessions (hash, user_id, created_at, expires_at, last_seen, agent, method) VALUES (?, ?, ?, ?, ?, ?, ?)",
      await sha256(token),
      userId,
      now,
      now + SESSION_MS,
      now,
      clean(agent, 300),
      method,
    );
    this.sql.exec("UPDATE users SET last_seen = ? WHERE id = ?", now, userId);
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM challenges WHERE expires_at < ?", now);
    return token;
  }
  private takeChallenge(id: string, kind: string, userId: string | null): string | null {
    const r = this.sql
      .exec("DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING challenge, user_id, expires_at", String(id), kind)
      .toArray()[0];
    if (!r || Number(r.expires_at) < Date.now()) return null;
    if (userId !== null && r.user_id !== userId) return null;
    return String(r.challenge);
  }

  /** Simple fixed-window rate limit. Returns false once `limit` is exceeded within `windowMs`. */
  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const r = this.sql.exec("SELECT count, window_start FROM hits WHERE key = ?", key).toArray()[0];
    if (!r || now - Number(r.window_start) > windowMs) {
      this.sql.exec("INSERT OR REPLACE INTO hits (key, count, window_start) VALUES (?, 1, ?)", key, now);
      if (Math.random() < 0.02) this.sql.exec("DELETE FROM hits WHERE window_start < ?", now - 86400_000);
      return true;
    }
    this.sql.exec("UPDATE hits SET count = count + 1 WHERE key = ?", key);
    return Number(r.count) + 1 <= limit;
  }

  // ---------------------------------------------------------------- sessions

  async googleLogin(p: { sub: string; email: string; name?: string; picture?: string }, agent: string): Promise<{ token: string } | { error: "not_allowed" }> {
    const email = p.email.toLowerCase();
    if (!this.sql.exec("SELECT 1 FROM members WHERE email = ?", email).toArray().length) return { error: "not_allowed" };
    let row = this.sql.exec("SELECT id FROM users WHERE email = ?", email).toArray()[0];
    if (!row) {
      const count = Number(this.sql.exec("SELECT COUNT(*) AS n FROM users").one().n);
      const id = randomId();
      this.sql.exec(
        "INSERT INTO users (id, email, google_sub, name, color, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        email,
        p.sub,
        clean(p.name, 40) || email.split("@")[0],
        USER_COLORS[count % USER_COLORS.length],
        p.picture?.startsWith("https://") ? p.picture : null,
        Date.now(),
      );
      row = { id };
    } else {
      this.sql.exec("UPDATE users SET google_sub = ? WHERE id = ?", p.sub, row.id);
      if (p.picture?.startsWith("https://")) this.sql.exec("UPDATE users SET avatar = ? WHERE id = ?", p.picture, row.id);
    }
    return { token: await this.newSession(String(row.id), agent, "google") };
  }

  /** Resolves a session token to its user, extending the session while it's in use. */
  async session(token: string): Promise<AuthUser | null> {
    if (!token || token.length > 100) return null;
    const hash = await sha256(token);
    const now = Date.now();
    const r = this.sql
      .exec(
        `SELECT u.id, u.email, u.name, u.color, u.avatar, m.role, s.last_seen
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN members m ON m.email = u.email
         WHERE s.hash = ? AND s.expires_at > ?`,
        hash,
        now,
      )
      .toArray()[0];
    if (!r) return null;
    if (now - Number(r.last_seen) > 5 * 60_000) {
      this.sql.exec("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE hash = ?", now, now + SESSION_MS, hash);
      this.sql.exec("UPDATE users SET last_seen = ? WHERE id = ?", now, r.id);
    }
    return this.toUser(r);
  }

  async logout(token: string) {
    const hash = await sha256(token);
    this.sql.exec("DELETE FROM sessions WHERE hash = ?", hash);
    await this.disconnect([hash]);
  }
  async logoutAll(userId: string) {
    const hashes = this.sql.exec("SELECT hash FROM sessions WHERE user_id = ?", userId).toArray().map((r) => String(r.hash));
    this.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
    await this.disconnect(hashes, userId);
  }

  // ---------------------------------------------------------------- live connections

  /** Called by a document room when a signed-in socket connects. */
  async registerSocket(room: string, session: string, userId: string) {
    const now = Date.now();
    this.sql.exec("INSERT OR REPLACE INTO sockets (room, session, user_id, at) VALUES (?, ?, ?, ?)", room, session, userId, now);
    if (Math.random() < 0.05) this.sql.exec("DELETE FROM sockets WHERE at < ?", now - 7 * 86400_000);
  }
  /** Checked by a document room every few minutes for each open connection: still signed in, and still in that workspace. */
  async sessionValid(hash: string, room?: string): Promise<boolean> {
    const r = this.sql
      .exec(
        "SELECT u.email FROM sessions s JOIN users u ON u.id = s.user_id JOIN members m ON m.email = u.email WHERE s.hash = ? AND s.expires_at > ?",
        hash,
        Date.now(),
      )
      .toArray()[0];
    if (!r) return false;
    if (room === undefined) return true;
    const ws = roomWorkspace(room);
    return !!ws && this.inWorkspace(String(r.email), ws);
  }
  /** Closes open live connections for these sessions (and, if given, every session of a user). */
  private async disconnect(hashes: string[], userId?: string) {
    const rows = userId
      ? this.sql.exec("SELECT room, session FROM sockets WHERE user_id = ?", userId).toArray()
      : hashes.length
        ? this.sql.exec(`SELECT room, session FROM sockets WHERE session IN (${hashes.map(() => "?").join(",")})`, ...hashes).toArray()
        : [];
    await this.kickSockets(rows);
  }
  /** Closes the open live connections of these people (or of everyone) to one workspace's documents. */
  private async disconnectFromWorkspace(ws: string, userIds?: string[]) {
    const who = userIds ? new Set(userIds) : null;
    const rows = this.sql
      .exec("SELECT room, session, user_id FROM sockets")
      .toArray()
      .filter((r) => roomWorkspace(String(r.room)) === ws && (!who || who.has(String(r.user_id))));
    await this.kickSockets(rows);
  }
  private async kickSockets(rows: Record<string, SqlStorageValue>[]) {
    const byRoom = new Map<string, string[]>();
    for (const r of rows) byRoom.set(String(r.room), [...(byRoom.get(String(r.room)) ?? []), String(r.session)]);
    await Promise.all(
      [...byRoom].map(([room, sessions]) => this.env.DOCS.get(this.env.DOCS.idFromName(room)).kick(sessions).catch(() => {})),
    );
    for (const [room, sessions] of byRoom) {
      for (const s of sessions) this.sql.exec("DELETE FROM sockets WHERE room = ? AND session = ?", room, s);
    }
  }
  async sessions(userId: string, token: string): Promise<SessionInfo[]> {
    const current = await sha256(token);
    return this.sql
      .exec("SELECT hash, created_at, last_seen, agent, method FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC", userId, Date.now())
      .toArray()
      .map((r) => ({
        id: String(r.hash).slice(0, 16),
        current: r.hash === current,
        createdAt: Number(r.created_at),
        lastSeen: Number(r.last_seen),
        agent: String(r.agent ?? ""),
        method: String(r.method ?? ""),
      }));
  }
  async revokeSession(userId: string, id: string) {
    if (!/^[0-9a-f]{16}$/.test(id)) return;
    const hashes = this.sql
      .exec("SELECT hash FROM sessions WHERE user_id = ? AND substr(hash, 1, 16) = ?", userId, id)
      .toArray()
      .map((r) => String(r.hash));
    this.sql.exec("DELETE FROM sessions WHERE user_id = ? AND substr(hash, 1, 16) = ?", userId, id);
    await this.disconnect(hashes);
  }

  // ---------------------------------------------------------------- profile & members

  async me(userId: string): Promise<AuthUser | null> {
    return this.user(userId);
  }
  async updateProfile(userId: string, patch: { name?: string; color?: string }): Promise<AuthUser | null> {
    if (patch.name !== undefined) {
      const name = clean(patch.name, 40);
      if (name) this.sql.exec("UPDATE users SET name = ? WHERE id = ?", name, userId);
    }
    if (patch.color !== undefined && /^#[0-9a-f]{6}$/i.test(patch.color)) {
      this.sql.exec("UPDATE users SET color = ? WHERE id = ?", patch.color, userId);
    }
    return this.user(userId);
  }

  /**
   * Everyone who can sign in. Members who aren't the owner need this only to pick who to share a workspace with,
   * so they get names and emails without when people were last active or how many passkeys they have.
   */
  async members(viewerId?: string): Promise<Member[]> {
    const full = !viewerId || this.user(viewerId)?.role === "owner";
    return this.sql
      .exec(
        `SELECT m.email, m.role, m.added_at, u.id, u.name, u.color, u.avatar, u.last_seen,
                (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
         FROM members m LEFT JOIN users u ON u.email = m.email
         ORDER BY m.role = 'owner' DESC, m.added_at`,
      )
      .toArray()
      .map((r) => ({
        email: String(r.email),
        role: r.role === "owner" ? "owner" : "member",
        addedAt: Number(r.added_at),
        user: r.id
          ? {
              id: String(r.id),
              name: String(r.name),
              color: String(r.color),
              avatar: r.avatar ? String(r.avatar) : null,
              lastSeen: full && r.last_seen ? Number(r.last_seen) : null,
              passkeys: full ? Number(r.passkeys) : 0,
            }
          : null,
      }));
  }
  async addMember(actorId: string, rawEmail: string): Promise<Member[]> {
    this.requireOwner(actorId);
    const email = clean(rawEmail, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) throw userError("That doesn't look like an email address.");
    this.sql.exec("INSERT OR IGNORE INTO members (email, role, added_by, added_at) VALUES (?, 'member', ?, ?)", email, actorId, Date.now());
    return this.members();
  }
  /** Removes a member: they're signed out everywhere and can't sign back in. Their past edits keep their name. */
  async removeMember(actorId: string, rawEmail: string): Promise<Member[]> {
    this.requireOwner(actorId);
    const email = clean(rawEmail, 254).toLowerCase();
    const actor = this.user(actorId)!;
    if (actor.email === email) throw userError("You can't remove yourself.");
    const target = this.sql.exec("SELECT id FROM users WHERE email = ?", email).toArray()[0];
    this.sql.exec("DELETE FROM members WHERE email = ?", email);
    // Shared workspaces they managed pass to someone still in them (the owner first), so they stay manageable.
    // Their place in workspaces is kept, which only matters if they're ever added back.
    for (const w of this.sql.exec("SELECT id FROM workspaces WHERE owner = ?", email).toArray()) {
      const next = this.sql
        .exec(
          `SELECT wm.email FROM workspace_members wm JOIN members m ON m.email = wm.email
           WHERE wm.ws = ? ORDER BY m.role = 'owner' DESC, wm.added_at LIMIT 1`,
          w.id,
        )
        .toArray()[0];
      if (next) this.sql.exec("UPDATE workspaces SET owner = ? WHERE id = ?", next.email, w.id);
    }
    if (target) {
      this.sql.exec("DELETE FROM sessions WHERE user_id = ?", target.id);
      this.sql.exec("DELETE FROM passkeys WHERE user_id = ?", target.id);
      // AI connections act as the person, so they end with them.
      this.sql.exec("DELETE FROM ai_tokens WHERE grant_id IN (SELECT id FROM ai_grants WHERE user_id = ?)", target.id);
      this.sql.exec("DELETE FROM ai_grants WHERE user_id = ?", target.id);
      await this.disconnect([], String(target.id));
    }
    return this.members();
  }

  // ---------------------------------------------------------------- workspaces

  private inWorkspace(email: string, ws: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.ws JOIN members m ON m.email = wm.email
           WHERE wm.ws = ? AND wm.email = ?`,
          ws,
          email,
        )
        .toArray().length > 0
    );
  }
  private toWorkspace(r: Record<string, SqlStorageValue>, viewer: string): Workspace {
    const members = this.sql
      .exec(
        `SELECT wm.email, u.id, u.name, u.color, u.avatar FROM workspace_members wm
         JOIN members m ON m.email = wm.email LEFT JOIN users u ON u.email = wm.email
         WHERE wm.ws = ? ORDER BY wm.email = ? DESC, wm.added_at`,
        r.id,
        viewer,
      )
      .toArray()
      .map((m) => ({
        email: String(m.email),
        user: m.id ? { id: String(m.id), name: String(m.name), color: String(m.color), avatar: m.avatar ? String(m.avatar) : null } : null,
      }));
    return {
      id: String(r.id),
      name: r.name == null ? null : String(r.name),
      icon: r.icon == null ? null : String(r.icon),
      owner: String(r.owner),
      isOwner: r.owner === viewer,
      createdAt: Number(r.created_at),
      members,
    };
  }
  /** The workspace, if this person may open it. */
  private workspaceFor(userId: string, ws: string): { me: AuthUser; row: Record<string, SqlStorageValue> } {
    const me = this.user(userId);
    if (!me || !WS_ID_RE.test(ws) || !this.inWorkspace(me.email, ws)) throw userError("That workspace doesn't exist, or you're not in it.");
    return { me, row: this.sql.exec("SELECT * FROM workspaces WHERE id = ?", ws).one() };
  }
  /** Only app members who are actually on the member list; the creator is always included. */
  private cleanMembers(emails: unknown, must: string): string[] {
    const list = Array.isArray(emails) ? emails.map((e) => clean(e, 254).toLowerCase()) : [];
    const allowed = new Set(this.sql.exec("SELECT email FROM members").toArray().map((r) => String(r.email)));
    return [...new Set([must, ...list.filter((e) => allowed.has(e))])];
  }

  /** Every workspace this person can open. Someone with none gets a private one, so there's always somewhere to land. */
  async workspaces(userId: string): Promise<Workspace[]> {
    const me = this.user(userId);
    if (!me) return [];
    const list = () =>
      this.sql
        .exec(
          `SELECT w.* FROM workspaces w JOIN workspace_members wm ON wm.ws = w.id
           WHERE wm.email = ? ORDER BY w.id = 'main' DESC, w.created_at`,
          me.email,
        )
        .toArray();
    let rows = list();
    if (!rows.length) {
      await this.createWorkspace(userId, { name: `${me.name.split(" ")[0]}'s space`, members: [] });
      rows = list();
    }
    return rows.map((r) => this.toWorkspace(r, me.email));
  }
  async canAccess(userId: string, ws: string): Promise<boolean> {
    const me = this.user(userId);
    return !!me && WS_ID_RE.test(ws) && this.inWorkspace(me.email, ws);
  }
  async createWorkspace(userId: string, p: { name?: unknown; icon?: unknown; members?: unknown }): Promise<Workspace> {
    const me = this.user(userId);
    if (!me) throw userError("Not signed in.");
    const owned = Number(this.sql.exec("SELECT COUNT(*) AS n FROM workspaces WHERE owner = ?", me.email).one().n);
    if (owned >= MAX_OWNED_WORKSPACES) throw userError(`You can have up to ${MAX_OWNED_WORKSPACES} workspaces.`);
    let id = randomId(10);
    while (this.sql.exec("SELECT 1 FROM workspaces WHERE id = ?", id).toArray().length) id = randomId(10);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO workspaces (id, name, icon, owner, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        clean(p.name, 60) || "Untitled workspace",
        clean(p.icon, 16) || null,
        me.email,
        now,
      );
      for (const email of this.cleanMembers(p.members, me.email)) {
        this.sql.exec("INSERT INTO workspace_members (ws, email, added_at) VALUES (?, ?, ?)", id, email, now);
      }
    });
    return this.toWorkspace(this.sql.exec("SELECT * FROM workspaces WHERE id = ?", id).one(), me.email);
  }
  /** Name and icon: anyone in the workspace can change them. */
  async updateWorkspace(userId: string, ws: string, p: { name?: unknown; icon?: unknown }): Promise<Workspace> {
    const { me } = this.workspaceFor(userId, ws);
    if (p.name !== undefined) {
      const name = clean(p.name, 60);
      if (name) this.sql.exec("UPDATE workspaces SET name = ? WHERE id = ?", name, ws);
    }
    if (p.icon !== undefined) this.sql.exec("UPDATE workspaces SET icon = ? WHERE id = ?", clean(p.icon, 16) || null, ws);
    return this.toWorkspace(this.sql.exec("SELECT * FROM workspaces WHERE id = ?", ws).one(), me.email);
  }
  /** Who's in it: only the person who manages the workspace decides. Anyone taken out is disconnected straight away. */
  async setWorkspaceMembers(userId: string, ws: string, emails: unknown): Promise<Workspace> {
    const { me, row } = this.workspaceFor(userId, ws);
    if (row.owner !== me.email) throw userError("Only the person who manages this workspace can change who's in it.");
    const next = new Set(this.cleanMembers(emails, me.email));
    const current = this.sql.exec("SELECT email FROM workspace_members WHERE ws = ?", ws).toArray().map((r) => String(r.email));
    const removed = current.filter((e) => !next.has(e));
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const e of removed) this.sql.exec("DELETE FROM workspace_members WHERE ws = ? AND email = ?", ws, e);
      for (const e of next) this.sql.exec("INSERT OR IGNORE INTO workspace_members (ws, email, added_at) VALUES (?, ?, ?)", ws, e, now);
    });
    if (removed.length) {
      const ids = this.sql
        .exec(`SELECT id FROM users WHERE email IN (${removed.map(() => "?").join(",")})`, ...removed)
        .toArray()
        .map((r) => String(r.id));
      await this.disconnectFromWorkspace(ws, ids);
    }
    return this.toWorkspace(this.sql.exec("SELECT * FROM workspaces WHERE id = ?", ws).one(), me.email);
  }
  async leaveWorkspace(userId: string, ws: string): Promise<void> {
    const { me, row } = this.workspaceFor(userId, ws);
    if (row.owner === me.email) throw userError("You manage this workspace, so you can't leave it. You can delete it instead.");
    this.sql.exec("DELETE FROM workspace_members WHERE ws = ? AND email = ?", ws, me.email);
    await this.disconnectFromWorkspace(ws, [me.id]);
  }
  /** Removes the workspace for everyone. The Worker then deletes its documents. */
  async deleteWorkspace(userId: string, ws: string): Promise<void> {
    const { me, row } = this.workspaceFor(userId, ws);
    if (row.owner !== me.email) throw userError("Only the person who manages this workspace can delete it.");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM workspace_members WHERE ws = ?", ws);
      this.sql.exec("DELETE FROM workspaces WHERE id = ?", ws);
    });
    await this.disconnectFromWorkspace(ws);
  }

  // ---------------------------------------------------------------- passkeys

  async listPasskeys(userId: string): Promise<Passkey[]> {
    return this.sql
      .exec("SELECT id, name, created_at, last_used, synced FROM passkeys WHERE user_id = ? ORDER BY created_at", userId)
      .toArray()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        createdAt: Number(r.created_at),
        lastUsed: r.last_used ? Number(r.last_used) : null,
        synced: !!r.synced,
      }));
  }
  async renamePasskey(userId: string, id: string, name: string): Promise<Passkey[]> {
    const n = clean(name, 60);
    if (n) this.sql.exec("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?", n, id, userId);
    return this.listPasskeys(userId);
  }
  async deletePasskey(userId: string, id: string): Promise<Passkey[]> {
    this.sql.exec("DELETE FROM passkeys WHERE id = ? AND user_id = ?", id, userId);
    return this.listPasskeys(userId);
  }

  async passkeyRegisterOptions(userId: string, rpID: string) {
    const user = this.user(userId);
    if (!user) throw userError("Not signed in.");
    const existing = this.sql.exec("SELECT id, transports FROM passkeys WHERE user_id = ?", userId).toArray();
    const options = await generateRegistrationOptions({
      rpName: "Sandpiper",
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new Uint8Array(enc.encode(user.id)),
      attestationType: "none",
      excludeCredentials: existing.map((r) => ({ id: String(r.id), transports: r.transports ? JSON.parse(String(r.transports)) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = randomToken(16);
    this.sql.exec(
      "INSERT INTO challenges (id, kind, user_id, challenge, expires_at) VALUES (?, 'register', ?, ?, ?)",
      challengeId,
      userId,
      options.challenge,
      Date.now() + CHALLENGE_MS,
    );
    return { challengeId, options };
  }

  async passkeyRegisterVerify(
    userId: string,
    challengeId: string,
    response: RegistrationResponseJSON,
    origin: string,
    rpID: string,
    name: string,
  ): Promise<Passkey[]> {
    const challenge = this.takeChallenge(challengeId, "register", userId);
    if (!challenge) throw userError("That took too long. Try adding the passkey again.");
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
    if (!result.verified) throw userError("The passkey couldn't be verified.");
    const { credential, credentialBackedUp } = result.registrationInfo;
    this.sql.exec(
      "INSERT OR REPLACE INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      credential.id,
      userId,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      clean(name, 60) || "Passkey",
      Date.now(),
      credentialBackedUp ? 1 : 0,
    );
    return this.listPasskeys(userId);
  }

  async passkeyLoginOptions(rpID: string) {
    const options = await generateAuthenticationOptions({ rpID, allowCredentials: [], userVerification: "preferred" });
    const challengeId = randomToken(16);
    this.sql.exec(
      "INSERT INTO challenges (id, kind, user_id, challenge, expires_at) VALUES (?, 'login', NULL, ?, ?)",
      challengeId,
      options.challenge,
      Date.now() + CHALLENGE_MS,
    );
    return { challengeId, options };
  }

  async passkeyLoginVerify(
    challengeId: string,
    response: AuthenticationResponseJSON,
    origin: string,
    rpID: string,
    agent: string,
  ): Promise<{ token: string } | { error: string }> {
    const challenge = this.takeChallenge(challengeId, "login", null);
    if (!challenge) return { error: "expired" };
    const pk = this.sql
      .exec(
        `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports FROM passkeys p
         JOIN users u ON u.id = p.user_id JOIN members m ON m.email = u.email WHERE p.id = ?`,
        String(response?.id ?? ""),
      )
      .toArray()[0];
    if (!pk) return { error: "unknown_passkey" };
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: String(pk.id),
          publicKey: new Uint8Array(pk.public_key as ArrayBuffer),
          counter: Number(pk.counter),
          transports: pk.transports ? JSON.parse(String(pk.transports)) : undefined,
        },
        requireUserVerification: false,
      });
    } catch {
      return { error: "invalid" };
    }
    if (!result.verified) return { error: "invalid" };
    this.sql.exec("UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?", result.authenticationInfo.newCounter, Date.now(), pk.id);
    return { token: await this.newSession(String(pk.user_id), agent, "passkey") };
  }

  // ---------------------------------------------------------------- AI connections (MCP)
  //
  // An AI app reaches Sandpiper's MCP server (/mcp) as one person, with that person's access and no more. It gets
  // there either through OAuth (the app sends the person here to approve it) or with an access token the person
  // creates in Settings. Each approval is a "grant": read only or read and edit, for all of their workspaces or
  // only some. Tokens are stored as hashes; the person can end any grant from Settings.

  /** Registers an app (OAuth dynamic client registration). */
  async oauthRegister(p: { name: string; uri: string | null; redirectUris: string[]; authMethod: string }): Promise<{ clientId: string; secret: string | null; createdAt: number }> {
    const clientId = "sp_client_" + randomToken(18);
    const secret = p.authMethod === "none" ? null : "sp_secret_" + randomToken(32);
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO oauth_clients (id, name, uri, redirect_uris, auth_method, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      clientId,
      clean(p.name, 100) || "AI app",
      p.uri,
      JSON.stringify(p.redirectUris),
      p.authMethod,
      secret ? await sha256(secret) : null,
      now,
    );
    // Registrations nobody ever used are cleared out after a while.
    if (Math.random() < 0.05) {
      this.sql.exec(
        "DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM ai_grants WHERE client_id IS NOT NULL)",
        now - 7 * 86400_000,
      );
    }
    return { clientId, secret, createdAt: now };
  }

  /** An app that identifies itself by the address of its metadata document (it's re-read on each sign-in). */
  async oauthSaveMetadataClient(p: { id: string; name: string; uri: string | null; redirectUris: string[] }) {
    this.sql.exec(
      `INSERT INTO oauth_clients (id, name, uri, redirect_uris, auth_method, secret_hash, created_at) VALUES (?, ?, ?, ?, 'none', NULL, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, uri = excluded.uri, redirect_uris = excluded.redirect_uris`,
      p.id,
      clean(p.name, 100) || "AI app",
      p.uri,
      JSON.stringify(p.redirectUris),
      Date.now(),
    );
  }

  async oauthClient(id: string): Promise<{ id: string; name: string; uri: string | null; redirectUris: string[]; authMethod: string } | null> {
    const r = this.sql.exec("SELECT * FROM oauth_clients WHERE id = ?", String(id).slice(0, 2000)).toArray()[0];
    if (!r) return null;
    return { id: String(r.id), name: String(r.name), uri: r.uri ? String(r.uri) : null, redirectUris: JSON.parse(String(r.redirect_uris)), authMethod: String(r.auth_method) };
  }

  /** Remembers an authorization request while the person decides; returns its id for the approval page. */
  async oauthCreateRequest(p: { clientId: string; redirectUri: string; state: string | null; challenge: string }): Promise<string> {
    const id = randomToken(24);
    const now = Date.now();
    this.sql.exec("DELETE FROM oauth_requests WHERE expires_at < ?", now);
    this.sql.exec(
      "INSERT INTO oauth_requests (id, client_id, redirect_uri, state, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      p.clientId,
      p.redirectUri,
      p.state,
      p.challenge,
      now + 15 * 60_000,
    );
    return id;
  }

  /** What the approval page shows: who's asking, where they'll be sent back to, and the person's workspaces. */
  async oauthRequest(userId: string, id: string) {
    const me = this.user(userId);
    const r = this.sql.exec("SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?", String(id), Date.now()).toArray()[0];
    if (!me || !r) return null;
    const client = await this.oauthClient(String(r.client_id));
    if (!client) return null;
    let host = "";
    try {
      const u = new URL(String(r.redirect_uri));
      host = u.protocol === "http:" || u.protocol === "https:" ? u.host : u.protocol.replace(/:$/, "");
    } catch {
      /* checked when the request was made */
    }
    return {
      client: { name: client.name, uri: client.uri, redirectHost: host },
      me: { name: me.name, email: me.email },
      workspaces: (await this.workspaces(userId)).map((w) => ({ id: w.id, name: w.name, icon: w.icon })),
    };
  }

  private checkAccess(userId: string, access: unknown, workspaces: unknown): { access: "read" | "write"; workspaces: string[] | null } {
    if (access !== "read" && access !== "write") throw userError("Choose read only, or read and edit.");
    if (workspaces === null || workspaces === undefined) return { access, workspaces: null };
    if (!Array.isArray(workspaces) || !workspaces.length) throw userError("Choose at least one workspace.");
    const me = this.user(userId)!;
    const list = [...new Set(workspaces.map(String))];
    for (const ws of list) if (!WS_ID_RE.test(ws) || !this.inWorkspace(me.email, ws)) throw userError("You can only share workspaces you're in.");
    return { access, workspaces: list };
  }

  /** The person approved or declined. Returns where to send the browser: back to the app, with a code or an error. */
  async oauthDecide(userId: string, id: string, d: { allow: boolean; access?: unknown; workspaces?: unknown }, issuer: string): Promise<{ redirect: string }> {
    const me = this.user(userId);
    const r = this.sql.exec("SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?", String(id), Date.now()).toArray()[0];
    if (!me || !r) throw userError("This request has expired. Start connecting again from the app you were using.");
    const back = new URL(String(r.redirect_uri));
    if (r.state) back.searchParams.set("state", String(r.state));
    back.searchParams.set("iss", issuer);
    if (!d.allow) {
      this.sql.exec("DELETE FROM oauth_requests WHERE id = ?", r.id);
      back.searchParams.set("error", "access_denied");
      return { redirect: back.toString() };
    }
    const choice = this.checkAccess(userId, d.access, d.workspaces);
    const client = (await this.oauthClient(String(r.client_id)))!;
    const now = Date.now();
    const grantId = randomId(12);
    const code = randomToken(32);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM oauth_requests WHERE id = ?", r.id);
      // Connecting the same app again replaces its earlier connection rather than adding another.
      for (const old of this.sql.exec("SELECT id FROM ai_grants WHERE user_id = ? AND client_id = ?", userId, client.id).toArray()) {
        this.sql.exec("DELETE FROM ai_tokens WHERE grant_id = ?", old.id);
        this.sql.exec("DELETE FROM ai_grants WHERE id = ?", old.id);
      }
      this.sql.exec(
        "INSERT INTO ai_grants (id, user_id, kind, client_id, name, access, workspaces, created_at) VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?)",
        grantId,
        userId,
        client.id,
        client.name,
        choice.access,
        choice.workspaces ? JSON.stringify(choice.workspaces) : null,
        now,
      );
    });
    this.sql.exec("DELETE FROM oauth_codes WHERE expires_at < ?", now);
    this.sql.exec(
      "INSERT INTO oauth_codes (hash, grant_id, client_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      await sha256(code),
      grantId,
      client.id,
      String(r.redirect_uri),
      String(r.challenge),
      now + 5 * 60_000,
    );
    back.searchParams.set("code", code);
    return { redirect: back.toString() };
  }

  private async issueTokens(grantId: string, access: string) {
    const now = Date.now();
    const accessToken = "sp_at_" + randomToken(32);
    const refreshToken = "sp_rt_" + randomToken(32);
    this.sql.exec("INSERT INTO ai_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, 'access', ?, ?)", await sha256(accessToken), grantId, now + AI_ACCESS_MS, now);
    this.sql.exec("INSERT INTO ai_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, 'refresh', ?, ?)", await sha256(refreshToken), grantId, now + AI_REFRESH_MS, now);
    if (Math.random() < 0.05) this.sql.exec("DELETE FROM ai_tokens WHERE expires_at IS NOT NULL AND expires_at < ?", now);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: AI_ACCESS_MS / 1000,
      refresh_token: refreshToken,
      scope: access === "write" ? "read write" : "read",
    };
  }

  /** The OAuth token endpoint's work: a code (with its PKCE verifier) or a refresh token for new tokens. */
  async oauthToken(p: {
    grantType: string;
    clientId: string;
    clientSecret: string | null;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
    refreshToken?: string;
  }): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string; description: string }> {
    const bad = (error: string, description: string, status = 400) => ({ ok: false as const, status, error, description });
    const client = await this.oauthClient(p.clientId);
    if (!client) return bad("invalid_client", "Unknown client.", 401);
    if (client.authMethod !== "none") {
      const row = this.sql.exec("SELECT secret_hash FROM oauth_clients WHERE id = ?", client.id).one();
      if (!p.clientSecret || (await sha256(p.clientSecret)) !== row.secret_hash) return bad("invalid_client", "Client authentication failed.", 401);
    }
    const now = Date.now();
    if (p.grantType === "authorization_code") {
      if (!p.code || !p.codeVerifier) return bad("invalid_request", "code and code_verifier are required.");
      const hash = await sha256(p.code);
      const r = this.sql.exec("SELECT * FROM oauth_codes WHERE hash = ?", hash).toArray()[0];
      if (!r || Number(r.expires_at) < now || r.client_id !== client.id) return bad("invalid_grant", "The code is invalid or has expired.");
      if (r.used) {
        // A code used twice may have been stolen: end the connection it made.
        this.sql.exec("DELETE FROM ai_tokens WHERE grant_id = ?", r.grant_id);
        this.sql.exec("DELETE FROM ai_grants WHERE id = ?", r.grant_id);
        return bad("invalid_grant", "The code was already used.");
      }
      this.sql.exec("UPDATE oauth_codes SET used = 1 WHERE hash = ?", hash);
      if (p.redirectUri && p.redirectUri !== r.redirect_uri) return bad("invalid_grant", "redirect_uri doesn't match.");
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(p.codeVerifier))));
      if (challenge !== r.challenge) return bad("invalid_grant", "PKCE verification failed.");
      const grant = this.sql.exec("SELECT * FROM ai_grants WHERE id = ?", r.grant_id).toArray()[0];
      if (!grant || !this.user(String(grant.user_id))) return bad("invalid_grant", "The connection no longer exists.");
      return { ok: true, body: await this.issueTokens(String(grant.id), String(grant.access)) };
    }
    if (p.grantType === "refresh_token") {
      if (!p.refreshToken) return bad("invalid_request", "refresh_token is required.");
      const hash = await sha256(p.refreshToken);
      const r = this.sql
        .exec(
          `SELECT t.hash, g.id, g.access, g.user_id, g.client_id FROM ai_tokens t JOIN ai_grants g ON g.id = t.grant_id
           WHERE t.hash = ? AND t.kind = 'refresh' AND t.expires_at > ?`,
          hash,
          now,
        )
        .toArray()[0];
      if (!r || r.client_id !== client.id || !this.user(String(r.user_id))) return bad("invalid_grant", "The refresh token is invalid or has expired.");
      // Each refresh token works once; the app gets a new one with each refresh.
      this.sql.exec("DELETE FROM ai_tokens WHERE hash = ?", hash);
      return { ok: true, body: await this.issueTokens(String(r.id), String(r.access)) };
    }
    return bad("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  /** Token revocation: a refresh token ends its whole connection; an access token just stops working. */
  async oauthRevoke(token: string) {
    const hash = await sha256(String(token ?? ""));
    const r = this.sql.exec("SELECT grant_id, kind FROM ai_tokens WHERE hash = ?", hash).toArray()[0];
    if (!r) return;
    if (r.kind === "refresh") {
      this.sql.exec("DELETE FROM ai_tokens WHERE grant_id = ?", r.grant_id);
      this.sql.exec("DELETE FROM ai_grants WHERE id = ? AND kind = 'oauth'", r.grant_id);
    } else this.sql.exec("DELETE FROM ai_tokens WHERE hash = ?", hash);
  }

  /** The person and grant behind an MCP request's bearer token, or null. */
  async aiAuth(token: string): Promise<{ user: AuthUser; grant: AiGrant } | null> {
    if (!token || token.length > 200) return null;
    const now = Date.now();
    const r = this.sql
      .exec(
        `SELECT g.* FROM ai_tokens t JOIN ai_grants g ON g.id = t.grant_id
         WHERE t.hash = ? AND t.kind IN ('access', 'pat') AND (t.expires_at IS NULL OR t.expires_at > ?)`,
        await sha256(token),
        now,
      )
      .toArray()[0];
    if (!r) return null;
    const user = this.user(String(r.user_id));
    if (!user) return null;
    if (now - Number(r.last_used ?? 0) > 60_000) this.sql.exec("UPDATE ai_grants SET last_used = ? WHERE id = ?", now, r.id);
    return { user, grant: toGrant(r) };
  }

  /** A connection limited to some workspaces also reaches a workspace it creates. */
  async aiGrantAddWorkspace(grantId: string, ws: string) {
    const r = this.sql.exec("SELECT workspaces FROM ai_grants WHERE id = ?", grantId).toArray()[0];
    if (!r?.workspaces) return;
    const list: string[] = JSON.parse(String(r.workspaces));
    if (!list.includes(ws)) this.sql.exec("UPDATE ai_grants SET workspaces = ? WHERE id = ?", JSON.stringify([...list, ws]), grantId);
  }

  async aiConnections(userId: string): Promise<AiConnection[]> {
    return this.sql
      .exec("SELECT * FROM ai_grants WHERE user_id = ? ORDER BY created_at DESC", userId)
      .toArray()
      .map((r) => {
        const g = toGrant(r);
        return { id: g.id, kind: g.kind, name: g.name, access: g.access, workspaces: g.workspaces, createdAt: g.createdAt, lastUsed: g.lastUsed };
      });
  }

  async aiDisconnect(userId: string, id: string): Promise<AiConnection[]> {
    const r = this.sql.exec("SELECT id FROM ai_grants WHERE id = ? AND user_id = ?", String(id), userId).toArray()[0];
    if (r) {
      this.sql.exec("DELETE FROM ai_tokens WHERE grant_id = ?", r.id);
      this.sql.exec("DELETE FROM ai_grants WHERE id = ?", r.id);
    }
    return this.aiConnections(userId);
  }

  /** An access token for apps that take one directly (shown once; only its hash is kept). */
  async aiCreateToken(userId: string, p: { name?: unknown; access?: unknown; workspaces?: unknown }): Promise<{ token: string; connections: AiConnection[] }> {
    if (!this.user(userId)) throw userError("Not signed in.");
    const name = clean(p.name, 60);
    if (!name) throw userError("Give the token a name, like the app you'll use it in.");
    const choice = this.checkAccess(userId, p.access, p.workspaces);
    const count = Number(this.sql.exec("SELECT COUNT(*) AS n FROM ai_grants WHERE user_id = ?", userId).one().n);
    if (count >= 50) throw userError("You have 50 connections already. Remove some you don't use first.");
    const id = randomId(12);
    const token = "sp_pat_" + randomToken(32);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO ai_grants (id, user_id, kind, client_id, name, access, workspaces, created_at) VALUES (?, ?, 'token', NULL, ?, ?, ?, ?)",
        id,
        userId,
        name,
        choice.access,
        choice.workspaces ? JSON.stringify(choice.workspaces) : null,
        now,
      );
    });
    this.sql.exec("INSERT INTO ai_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, 'pat', NULL, ?)", await sha256(token), id, now);
    return { token, connections: await this.aiConnections(userId) };
  }
}

export interface AiGrant {
  id: string;
  userId: string;
  kind: "oauth" | "token";
  name: string;
  access: "read" | "write";
  /** null: every workspace the person is in, including new ones. */
  workspaces: string[] | null;
  createdAt: number;
  lastUsed: number | null;
}
export type AiConnection = Omit<AiGrant, "userId">;

const AI_ACCESS_MS = 60 * 60_000;
const AI_REFRESH_MS = 90 * 86400_000;

function toGrant(r: Record<string, SqlStorageValue>): AiGrant {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    kind: r.kind === "token" ? "token" : "oauth",
    name: String(r.name),
    access: r.access === "write" ? "write" : "read",
    workspaces: r.workspaces ? JSON.parse(String(r.workspaces)) : null,
    createdAt: Number(r.created_at),
    lastUsed: r.last_used ? Number(r.last_used) : null,
  };
}
function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
