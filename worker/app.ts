// HTTP routing for the Worker: sign-in, the account and workspace API, and the document/file API.
// Everything under /api (except sign-in), /collab and /uploads requires a session, and anything that touches a
// workspace's documents, files or search also requires being in that workspace.
import type { AuthStore, AuthUser } from "./auth";
import { SESSION_DAYS, USER_ERROR } from "./auth";
import type { Env } from "./index";
import { roomName, roomPageId, roomWorkspace, searchName, WS_ID_RE } from "./rooms";
import { oauthRoutes } from "./oauth";
import { handleMcp } from "./mcp/server";

type Auth = DurableObjectStub<AuthStore>;
const MAX_UPLOAD = 25 * 1024 * 1024;
const SESSION_COOKIE = "__Host-sp_session";
const OAUTH_COOKIE = "__Host-sp_oauth";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
};
// Uploaded files a browser may show inline. Everything else is sent as a download.
const INLINE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a", ".pdf"]);
const UPLOAD_NAME_RE = /^[0-9a-f-]{36}(\.[a-z0-9]{1,8}){0,2}$/;
/** The only place sign-in may return to other than home: an AI app's approval page. */
const NEXT_RE = /^\/connect\?request=[A-Za-z0-9_-]{16,64}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
const redirect = (location: string, cookies: string[] = []) => {
  const h = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
};
const extOf = (name: string) => /\.[a-z0-9]{1,8}$/.exec(name.toLowerCase())?.[0] ?? "";

function setCookie(name: string, value: string, maxAgeSeconds: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
function getCookie(request: Request, name: string): string {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomB64(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}
async function sha256hex(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The origin the browser is on. Under `npm run dev`, wrangler is told to present the Vite dev
 * server's address (--local-upstream localhost:5199), so this is right in both places.
 */
function appOrigin(request: Request, _env: Env): string {
  return new URL(request.url).origin;
}

/** True only under `npm run dev`, which passes LOCAL_DEV=1. Never set in production. */
const isDev = (env: Env) => env.LOCAL_DEV === "1";

/** Blocks cross-site use of the session cookie for anything that changes data or opens live sync. */
function checkOrigin(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== appOrigin(request, env)) throw new HttpError(403, "Cross-site request blocked");
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      // Errors thrown on purpose inside the account store carry a user-facing message.
      const message = err instanceof Error ? err.message : "";
      const at = message.indexOf(USER_ERROR);
      if (at >= 0) return json({ error: message.slice(at + USER_ERROR.length) }, 400);
      console.error(err);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname;
  const auth = env.AUTH.get(env.AUTH.idFromName("auth"));
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const agent = request.headers.get("User-Agent") || "";

  // ------------------------------------------------------------ MCP and OAuth (bearer tokens, never the session cookie)

  if (p === "/mcp" || p === "/mcp/") return handleMcp(request, env, auth, appOrigin(request, env));
  const oauth = await oauthRoutes(request, env, auth, appOrigin(request, env), ip);
  if (oauth) return oauth;

  // ------------------------------------------------------------ public: sign-in

  if (p === "/api/health") return json({ ok: true });

  if (p === "/auth/google" && request.method === "GET") return googleStart(request, env);
  if (p === "/auth/google/callback" && request.method === "GET") return googleCallback(request, env, auth, agent);

  if (p === "/api/auth/me" && request.method === "GET") {
    const token = getCookie(request, SESSION_COOKIE);
    const user = token ? await auth.session(token) : null;
    if (!user) return json({ error: "Not signed in" }, 401);
    // Refresh the cookie so an active session doesn't expire in the browser.
    return json({ user, workspaces: await auth.workspaces(user.id) }, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, token, SESSION_DAYS * 86400) });
  }

  if (p === "/api/auth/passkey/options" && request.method === "POST") {
    checkOrigin(request, env);
    if (!(await auth.hit("passkey:" + ip, 40, 10 * 60_000))) throw new HttpError(429, "Too many attempts. Wait a few minutes.");
    return json(await auth.passkeyLoginOptions(new URL(appOrigin(request, env)).hostname));
  }
  if (p === "/api/auth/passkey/verify" && request.method === "POST") {
    checkOrigin(request, env);
    const b = await body<{ challengeId: string; response: any }>(request);
    const origin = appOrigin(request, env);
    const result = await auth.passkeyLoginVerify(String(b.challengeId), b.response, origin, new URL(origin).hostname, agent);
    if ("error" in result) {
      const msg =
        result.error === "unknown_passkey"
          ? "This passkey isn't registered with Sandpiper, or its account was removed. Sign in with Google instead."
          : result.error === "expired"
            ? "That took too long. Try again."
            : "The passkey couldn't be verified. Try again.";
      return json({ error: msg }, 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, result.token, SESSION_DAYS * 86400) });
  }

  // ------------------------------------------------------------ everything below needs a session

  const needsSession = p.startsWith("/api/") || p.startsWith("/collab/") || p.startsWith("/uploads/");
  if (!needsSession) return env.ASSETS.fetch(request);

  const token = getCookie(request, SESSION_COOKIE);
  const user = token ? await auth.session(token) : null;
  if (!user) return json({ error: "Not signed in" }, 401);
  if (request.method !== "GET" || p.startsWith("/collab/")) checkOrigin(request, env);

  // Live sync: tell the document room which session and person this connection belongs to,
  // so it can be closed if they're removed or signed out.
  const collab = /^\/collab\/([^/]+)$/.exec(p);
  if (collab) {
    const ws = roomWorkspace(collab[1]);
    if (!ws) return new Response("bad room", { status: 400 });
    if (!(await auth.canAccess(user.id, ws))) return new Response("Not in this workspace", { status: 403 });
    const headers = new Headers(request.headers);
    headers.set("X-Sandpiper-Session", await sha256hex(token));
    headers.set("X-Sandpiper-User", user.id);
    return env.DOCS.get(env.DOCS.idFromName(collab[1])).fetch(new Request(request, { headers }));
  }

  const accountResponse = await accountRoutes(request, env, auth, user, token, p);
  if (accountResponse) return accountResponse;
  const workspaceResponse = await workspaceRoutes(request, env, auth, user, p);
  if (workspaceResponse) return workspaceResponse;
  return dataRoutes(request, env, auth, user, url, p);
}

// ================================================================ Google

async function googleStart(request: Request, env: Env): Promise<Response> {
  const origin = appOrigin(request, env);
  const mock = mockOAuth(request, env);
  if (!env.GOOGLE_CLIENT_ID || (!env.GOOGLE_CLIENT_SECRET && !mock)) return redirect("/?login_error=google_not_configured");
  const state = randomB64(24);
  const verifier = randomB64(32);
  const nonce = randomB64(16);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: origin + "/auth/google/callback",
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  // Where to go after signing in: only back to an AI app's approval page, never anywhere else.
  const next = new URL(request.url).searchParams.get("next") ?? "";
  const back = NEXT_RE.test(next) ? b64url(new TextEncoder().encode(next)) : "";
  const cookie = setCookie(OAUTH_COOKIE, `${state}.${verifier}.${nonce}.${back}`, 600);
  return redirect(`${mock ? mock + "/auth" : GOOGLE_AUTH}?${params}`, [cookie]);
}

async function googleCallback(request: Request, env: Env, auth: DurableObjectStub<import("./auth").AuthStore>, agent: string): Promise<Response> {
  const url = new URL(request.url);
  const origin = appOrigin(request, env);
  const clear = setCookie(OAUTH_COOKIE, "", 0);
  const fail = (code: string) => redirect("/?login_error=" + code, [clear]);

  const [state, verifier, nonce, back] = getCookie(request, OAUTH_COOKIE).split(".");
  let next = "/";
  try {
    const decoded = back ? new TextDecoder().decode(Uint8Array.from(atob(back.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))) : "";
    if (NEXT_RE.test(decoded)) next = decoded;
  } catch {
    /* not a valid return address: go home */
  }
  if (url.searchParams.get("error")) return fail("google_cancelled");
  if (!state || state !== url.searchParams.get("state")) return fail("expired");
  const code = url.searchParams.get("code");
  if (!code) return fail("google_failed");

  const mock = mockOAuth(request, env);
  const res = await fetch(mock ? mock + "/token" : GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: origin + "/auth/google/callback",
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    console.error("Google token exchange failed", res.status, await res.text().catch(() => ""));
    return fail("google_failed");
  }
  const tokens = (await res.json()) as { id_token?: string };
  // The ID token came straight from Google's token endpoint over TLS, so (per OpenID Connect)
  // its claims can be trusted without checking the signature; the claims are still validated.
  let claims: { iss?: string; aud?: string; exp?: number; nonce?: string; sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
  try {
    const part = tokens.id_token!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0))));
  } catch {
    return fail("google_failed");
  }
  const issuers = mock ? [mock] : GOOGLE_ISSUERS;
  if (
    !issuers.includes(claims.iss ?? "") ||
    claims.aud !== env.GOOGLE_CLIENT_ID ||
    (claims.exp ?? 0) * 1000 < Date.now() ||
    claims.nonce !== nonce ||
    !claims.sub ||
    !claims.email ||
    claims.email_verified !== true
  ) {
    return fail("google_failed");
  }
  const result = await auth.googleLogin({ sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture }, agent);
  if ("error" in result) return fail("not_allowed");
  return redirect(next, [clear, setCookie(SESSION_COOKIE, result.token, SESSION_DAYS * 86400)]);
}

/** A stand-in for Google used by the local test suite. Only honoured in local development. */
function mockOAuth(request: Request, env: Env): string | null {
  if (!env.OAUTH_MOCK_URL || !isDev(env)) return null;
  return env.OAUTH_MOCK_URL.replace(/\/$/, "");
}

// ================================================================ account API

async function accountRoutes(
  request: Request,
  env: Env,
  auth: DurableObjectStub<import("./auth").AuthStore>,
  user: AuthUser,
  token: string,
  p: string,
): Promise<Response | null> {
  const m = request.method;
  const origin = appOrigin(request, env);
  const rpID = new URL(origin).hostname;

  if (p === "/api/auth/logout" && m === "POST") {
    await auth.logout(token);
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) });
  }
  if (p === "/api/auth/logout-all" && m === "POST") {
    await auth.logoutAll(user.id);
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) });
  }
  if (p === "/api/me" && m === "PATCH") {
    const b = await body<{ name?: string; color?: string }>(request);
    return json({ user: await auth.updateProfile(user.id, b) });
  }

  if (p === "/api/sessions" && m === "GET") return json({ sessions: await auth.sessions(user.id, token) });
  const sess = /^\/api\/sessions\/([0-9a-f]{16})$/.exec(p);
  if (sess && m === "DELETE") {
    await auth.revokeSession(user.id, sess[1]);
    return json({ sessions: await auth.sessions(user.id, token) });
  }

  if (p === "/api/members" && m === "GET") return json({ members: await auth.members(user.id) });
  if (p === "/api/members" && m === "POST") {
    const b = await body<{ email: string }>(request);
    return json({ members: await auth.addMember(user.id, String(b.email ?? "")) });
  }
  const mem = /^\/api\/members\/([^/]+)$/.exec(p);
  if (mem && m === "DELETE") return json({ members: await auth.removeMember(user.id, decodeURIComponent(mem[1])) });

  if (p === "/api/passkeys" && m === "GET") return json({ passkeys: await auth.listPasskeys(user.id) });
  if (p === "/api/passkeys/register/options" && m === "POST") return json(await auth.passkeyRegisterOptions(user.id, rpID));
  if (p === "/api/passkeys/register/verify" && m === "POST") {
    const b = await body<{ challengeId: string; response: any; name?: string }>(request);
    return json({ passkeys: await auth.passkeyRegisterVerify(user.id, String(b.challengeId), b.response, origin, rpID, String(b.name ?? "")) });
  }
  const pk = /^\/api\/passkeys\/([A-Za-z0-9_-]{1,512})$/.exec(p);
  if (pk && m === "PATCH") {
    const b = await body<{ name: string }>(request);
    return json({ passkeys: await auth.renamePasskey(user.id, pk[1], String(b.name ?? "")) });
  }
  if (pk && m === "DELETE") return json({ passkeys: await auth.deletePasskey(user.id, pk[1]) });

  // AI connections: the approval page for an app asking to connect, and the list in Settings → AI & apps.
  const req = /^\/api\/oauth\/requests\/([A-Za-z0-9_-]{16,64})$/.exec(p);
  if (req && m === "GET") {
    const info = await auth.oauthRequest(user.id, req[1]);
    return info ? json(info) : json({ error: "This request has expired. Start connecting again from the app you were using." }, 404);
  }
  if (req && m === "POST") {
    const b = await body<{ allow?: boolean; access?: string; workspaces?: string[] | null }>(request);
    return json(await auth.oauthDecide(user.id, req[1], { allow: !!b.allow, access: b.access, workspaces: b.workspaces }, origin));
  }
  if (p === "/api/connections" && m === "GET") return json({ connections: await auth.aiConnections(user.id) });
  if (p === "/api/connections/tokens" && m === "POST") {
    const b = await body<{ name?: string; access?: string; workspaces?: string[] | null }>(request);
    return json(await auth.aiCreateToken(user.id, b));
  }
  const conn = /^\/api\/connections\/([a-z0-9]{12})$/.exec(p);
  if (conn && m === "DELETE") return json({ connections: await auth.aiDisconnect(user.id, conn[1]) });

  return null;
}

// ================================================================ workspaces

async function workspaceRoutes(request: Request, env: Env, auth: Auth, user: AuthUser, p: string): Promise<Response | null> {
  const m = request.method;
  if (p === "/api/workspaces" && m === "GET") return json({ workspaces: await auth.workspaces(user.id) });
  if (p === "/api/workspaces" && m === "POST") {
    const b = await body<{ name?: string; icon?: string; members?: string[] }>(request);
    return json({ workspace: await auth.createWorkspace(user.id, b) });
  }
  const one = /^\/api\/workspaces\/([a-z0-9]+)(\/members|\/leave)?$/.exec(p);
  if (!one || !WS_ID_RE.test(one[1])) return null;
  const [, id, sub] = one;
  if (!sub && m === "PATCH") {
    const b = await body<{ name?: string; icon?: string | null }>(request);
    return json({ workspace: await auth.updateWorkspace(user.id, id, b) });
  }
  if (sub === "/members" && m === "PUT") {
    const b = await body<{ emails: string[] }>(request);
    return json({ workspace: await auth.setWorkspaceMembers(user.id, id, b.emails) });
  }
  if (sub === "/leave" && m === "POST") {
    await auth.leaveWorkspace(user.id, id);
    return json({ ok: true });
  }
  if (!sub && m === "DELETE") {
    await auth.deleteWorkspace(user.id, id);
    await wipeWorkspace(env, id);
    return json({ ok: true });
  }
  return null;
}

/** Stores an uploaded file for a workspace. Types a browser could run as a page are stored as plain text. */
export async function saveUpload(
  env: Env,
  ws: string,
  originalName: string,
  body: ReadableStream | ArrayBuffer | null,
): Promise<{ url: string; name: string } | { error: string; status: number }> {
  const original = originalName.slice(0, 200);
  let ext = extOf(original);
  if ([".html", ".htm", ".xhtml", ".svg", ".js", ".mjs", ".xml"].includes(ext)) ext += ".txt";
  if (body instanceof ArrayBuffer && body.byteLength > MAX_UPLOAD) return { error: "too large", status: 413 };
  const name = crypto.randomUUID() + ext;
  const res = await env.FILES.get(env.FILES.idFromName(name)).fetch("https://files/put", {
    method: "PUT",
    body,
    headers: { "X-Sandpiper-Ws": ws },
  });
  if (!res.ok) return { error: res.status === 413 ? "too large" : "upload failed", status: res.status };
  return { url: "/uploads/" + name, name: original };
}

/** Deletes a removed workspace's documents and search index. Its files are left unreachable (nobody is in it). */
export async function wipeWorkspace(env: Env, ws: string) {
  const tree = env.DOCS.get(env.DOCS.idFromName(roomName(ws, "workspace")));
  const pageIds = await tree.pageIds().catch(() => [] as string[]);
  for (let i = 0; i < pageIds.length; i += 20) {
    await Promise.all(
      pageIds.slice(i, i + 20).map((id) => env.DOCS.get(env.DOCS.idFromName(roomName(ws, "page-" + id))).destroy().catch(() => {})),
    );
  }
  await tree.destroy().catch(() => {});
  await env.SEARCH.get(env.SEARCH.idFromName(searchName(ws))).clear().catch(() => {});
}

// ================================================================ documents, files, search

/** The workspace named in ?ws= (the original one if absent), checked against who's asking. */
async function requestedWorkspace(url: URL, auth: Auth, user: AuthUser): Promise<string> {
  const ws = url.searchParams.get("ws") || "main";
  if (!WS_ID_RE.test(ws) || !(await auth.canAccess(user.id, ws))) throw new HttpError(403, "Not in this workspace");
  return ws;
}
/** A page room the person may use, and the workspace it's in. */
async function pageRoom(room: string, auth: Auth, user: AuthUser): Promise<{ ws: string; pageId: string }> {
  const ws = roomWorkspace(room);
  const pageId = roomPageId(room);
  if (!ws || !pageId) throw new HttpError(400, "bad room");
  if (!(await auth.canAccess(user.id, ws))) throw new HttpError(403, "Not in this workspace");
  return { ws, pageId };
}

async function dataRoutes(request: Request, env: Env, auth: Auth, user: AuthUser, url: URL, p: string): Promise<Response> {
  if (p === "/api/upload" && request.method === "POST") {
    const ws = await requestedWorkspace(url, auth, user);
    if (Number(request.headers.get("Content-Length") || 0) > MAX_UPLOAD) return json({ error: "too large" }, 413);
    const saved = await saveUpload(env, ws, url.searchParams.get("name") || "file", request.body);
    return "error" in saved ? json({ error: saved.error }, saved.status) : json(saved);
  }

  if (p.startsWith("/uploads/")) {
    const name = decodeURIComponent(p.slice("/uploads/".length));
    if (!UPLOAD_NAME_RE.test(name)) return json({ error: "not found" }, 404);
    const res = await env.FILES.get(env.FILES.idFromName(name)).fetch("https://files/get");
    if (!res.ok) return json({ error: "not found" }, 404);
    // Only people in the file's workspace can open it; to anyone else it doesn't exist.
    if (!(await auth.canAccess(user.id, res.headers.get("X-Sandpiper-Ws") || "main"))) {
      await res.body?.cancel();
      return json({ error: "not found" }, 404);
    }
    const ext = extOf(name);
    return new Response(res.body, {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": INLINE.has(ext) ? "inline" : "attachment",
      },
    });
  }

  if (p === "/api/search" && request.method === "GET") {
    const ws = await requestedWorkspace(url, auth, user);
    const results = await env.SEARCH.get(env.SEARCH.idFromName(searchName(ws))).search(url.searchParams.get("q") || "");
    return json({ results });
  }

  if (p === "/api/copy" && request.method === "POST") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const a = await pageRoom(from, auth, user);
    const b = await pageRoom(to, auth, user);
    if (a.ws !== b.ws) return json({ error: "bad room" }, 400);
    const state = await env.DOCS.get(env.DOCS.idFromName(from)).getState();
    const ok = await env.DOCS.get(env.DOCS.idFromName(to)).putState(to, state);
    return ok ? json({ ok: true }) : json({ error: "exists" }, 409);
  }

  // Blocks moved to another page (the block menu's "Move to", "Turn into page"): added at the end of that page.
  if (p === "/api/append" && request.method === "POST") {
    const room = url.searchParams.get("room") || "";
    const { ws, pageId } = await pageRoom(room, auth, user);
    if (Number(request.headers.get("Content-Length") || 0) > 2_000_000) return json({ error: "too large" }, 413);
    const body = await request.json<{ blocks?: unknown }>().catch(() => null);
    if (!body || !Array.isArray(body.blocks) || !body.blocks.length) return json({ error: "Nothing to add." }, 400);
    const tree = env.DOCS.get(env.DOCS.idFromName(roomName(ws, "workspace")));
    const snap = (await tree.run(roomName(ws, "workspace"), "tree", "snapshot", {}, { userId: user.id })) as { pages: Record<string, any> };
    const page = snap.pages[pageId];
    if (!page || page.trashed) return json({ error: "That page no longer exists." }, 404);
    if (page.locked) return json({ error: "That page is locked." }, 409);
    try {
      await env.DOCS.get(env.DOCS.idFromName(room)).run(room, "content", "write", { mode: "append", source: { blocks: body.blocks } }, { userId: user.id });
    } catch (err) {
      const msg = String((err as Error)?.message ?? "");
      return json({ error: msg.startsWith(USER_ERROR) ? msg.slice(USER_ERROR.length) : "Those blocks couldn't be added." }, 400);
    }
    return json({ ok: true });
  }

  // A link's title, description, image and icon, for bookmark blocks.
  if (p === "/api/unfurl" && request.method === "GET") {
    return json(await unfurl(url.searchParams.get("url") || ""));
  }

  // PlantUML diagrams are drawn by plantuml.com's public server (PlantUML runs on Java, which this server can't).
  if (p === "/api/plantuml" && request.method === "POST") {
    const src = (await request.text()).slice(0, 60_000);
    if (!src.trim()) return new Response("", { status: 400 });
    const res = await fetch("https://www.plantuml.com/plantuml/svg/" + (await plantumlEncode(/@start/.test(src) ? src : `@startuml\n${src}\n@enduml`)), {
      cf: { cacheTtl: 86_400, cacheEverything: true },
      signal: AbortSignal.timeout(10_000),
    } as RequestInit).catch(() => null);
    if (!res) return new Response("plantuml.com didn't answer. Try again in a moment.", { status: 502 });
    const svg = await res.text();
    if (!svg.startsWith("<svg") && !svg.startsWith("<?xml")) return new Response("PlantUML couldn't draw this diagram.", { status: 502 });
    const problem = res.headers.get("X-PlantUML-Diagram-Error");
    if (!res.ok || problem) return new Response(problem ? `Line ${res.headers.get("X-PlantUML-Diagram-Error-Line") ?? "?"}: ${problem}` : "PlantUML couldn't read this diagram.", { status: 422 });
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "private, max-age=86400" } });
  }

  if (p === "/api/doc" && request.method === "DELETE") {
    const room = url.searchParams.get("room") || "";
    const { ws, pageId } = await pageRoom(room, auth, user);
    await env.DOCS.get(env.DOCS.idFromName(room)).destroy();
    await env.SEARCH.get(env.SEARCH.idFromName(searchName(ws))).remove(pageId);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

// ================================================================ link previews and PlantUML

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENT[m] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

/** A page's title, description, preview image and icon, from its <head>. Empty fields when it can't be read. */
async function unfurl(raw: string): Promise<{ title: string; description: string; image: string; icon: string }> {
  const empty = { title: "", description: "", image: "", icon: "" };
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return empty;
  }
  if (!/^https?:$/.test(target.protocol)) return empty;
  const res = await fetch(target.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; LinkPreview/1.0)", Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(6000),
    cf: { cacheTtl: 3600 },
  } as RequestInit).catch(() => null);
  if (!res || !res.ok || !/html/i.test(res.headers.get("Content-Type") ?? "")) {
    await res?.body?.cancel();
    return { ...empty, title: target.host };
  }
  // The head is near the start; read at most 300 KB.
  const reader = res.body!.getReader();
  let html = "";
  const dec = new TextDecoder();
  while (html.length < 300_000) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  await reader.cancel().catch(() => {});
  const meta = (name: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = re.exec(html)?.[0];
    return tag ? unescape(/content=["']([^"']*)["']/i.exec(tag)?.[1] ?? "").trim() : "";
  };
  const abs = (u: string) => {
    if (!u.trim()) return "";
    try {
      const x = new URL(u, res.url || target);
      return /^https?:$/.test(x.protocol) ? x.toString() : "";
    } catch {
      return "";
    }
  };
  const title = meta("og:title") || meta("twitter:title") || unescape(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim() || target.host;
  const description = meta("og:description") || meta("description") || meta("twitter:description");
  const image = abs(meta("og:image") || meta("twitter:image"));
  const iconTag = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i.exec(html)?.[0];
  const icon = abs(iconTag ? (/href=["']([^"']+)["']/i.exec(iconTag)?.[1] ?? "") : "/favicon.ico");
  return { title: title.slice(0, 300), description: description.slice(0, 600), image: image.slice(0, 2000), icon: icon.slice(0, 2000) };
}

/** PlantUML's text encoding: raw deflate, then its own base64 alphabet. */
async function plantumlEncode(src: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(src)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  const six = (b: number) => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"[b & 0x3f];
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += six(b1 >> 2) + six(((b1 & 0x3) << 4) | (b2 >> 4)) + six(((b2 & 0xf) << 2) | (b3 >> 6)) + six(b3);
  }
  return out;
}
