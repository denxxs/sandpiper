// OAuth 2.1 for AI apps connecting to Sandpiper's MCP server, as the MCP authorization spec describes:
//   /.well-known/oauth-protected-resource      which authorization server protects /mcp
//   /.well-known/oauth-authorization-server    this server's endpoints
//   /oauth/register                            dynamic client registration (apps register themselves)
//   /oauth/authorize                           checks the request, then sends the person to /connect to approve it
//   /oauth/token                               code (+ PKCE) or refresh token → tokens
//   /oauth/revoke                              ends a token
// Apps may also identify themselves by the address of a client metadata document instead of registering.
// The approval page (/connect) is part of the web app; it talks to /api/oauth/requests/<id> with the session cookie.
import type { AuthStore } from "./auth";
import type { Env } from "./index";

type Auth = DurableObjectStub<AuthStore>;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...headers },
  });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS });
export { CORS };

/** The address of this MCP server (the protected resource). */
export const resourceUrl = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

/** Handles the OAuth endpoints and metadata; null if the path isn't one of them. */
export async function oauthRoutes(request: Request, env: Env, auth: Auth, origin: string, ip: string): Promise<Response | null> {
  const p = new URL(request.url).pathname;
  const m = request.method;
  const isOAuth = p.startsWith("/oauth/") || p.startsWith("/.well-known/");
  if (!isOAuth) return null;
  if (m === "OPTIONS") return corsPreflight();

  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
    return json({
      resource: resourceUrl(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read", "write"],
      resource_name: "Sandpiper",
      resource_documentation: `${origin}/`,
    });
  }
  if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server/mcp" || p === "/.well-known/openid-configuration") {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["read", "write"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${origin}/`,
    });
  }

  if (p === "/oauth/register" && m === "POST") {
    if (!(await auth.hit("oauth-register:" + ip, 30, 60 * 60_000))) return oauthError("too_many_requests", "Too many registrations. Try again later.", 429);
    let meta: any;
    try {
      meta = await request.json();
    } catch {
      return oauthError("invalid_client_metadata", "Expected a JSON body.");
    }
    const uris = meta?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) return oauthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 addresses.");
    for (const u of uris) if (!validRedirect(u)) return oauthError("invalid_redirect_uri", `Not allowed as a redirect address: ${String(u).slice(0, 200)}`);
    const method = meta.token_endpoint_auth_method ?? "client_secret_basic";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
    const grants: string[] = meta.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
    }
    const name = String(meta.client_name ?? "").slice(0, 100) || hostOf(uris[0]) || "AI app";
    const uri = typeof meta.client_uri === "string" && /^https:\/\//.test(meta.client_uri) ? meta.client_uri.slice(0, 500) : null;
    const reg = await auth.oauthRegister({ name, uri, redirectUris: uris, authMethod: method });
    return json(
      {
        client_id: reg.clientId,
        client_id_issued_at: Math.floor(reg.createdAt / 1000),
        ...(reg.secret ? { client_secret: reg.secret, client_secret_expires_at: 0 } : {}),
        client_name: name,
        ...(uri ? { client_uri: uri } : {}),
        redirect_uris: uris,
        grant_types: grants,
        response_types: ["code"],
        token_endpoint_auth_method: method,
      },
      201,
    );
  }

  if (p === "/oauth/authorize" && m === "GET") {
    const q = new URL(request.url).searchParams;
    const clientId = q.get("client_id") ?? "";
    const client = await resolveClient(auth, clientId);
    // Until the client and its redirect address check out, errors are shown here, never sent anywhere.
    if (!client) return redirect("/connect?error=unknown_app");
    const asked = q.get("redirect_uri");
    const redirectUri = asked ? client.redirectUris.find((r) => sameRedirect(r, asked)) && asked : client.redirectUris.length === 1 ? client.redirectUris[0] : null;
    if (!redirectUri) return redirect("/connect?error=bad_redirect");
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.get("state")) u.searchParams.set("state", q.get("state")!);
      u.searchParams.set("iss", origin);
      return redirect(u.toString());
    };
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = q.get("code_challenge") ?? "";
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || (q.get("code_challenge_method") ?? "plain") !== "S256") {
      return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    const resource = q.get("resource");
    if (resource && !validResource(resource, origin)) return back("invalid_target", `This server's resource is ${resourceUrl(origin)}.`);
    const id = await auth.oauthCreateRequest({ clientId: client.id, redirectUri, state: q.get("state"), challenge });
    return redirect(`/connect?request=${encodeURIComponent(id)}`);
  }

  if (p === "/oauth/token" && m === "POST") {
    if (!(await auth.hit("oauth-token:" + ip, 120, 10 * 60_000))) return oauthError("too_many_requests", "Too many requests. Try again later.", 429);
    const form = await formBody(request);
    const basic = basicAuth(request);
    const resource = form.get("resource");
    if (resource && !validResource(resource, origin)) return oauthError("invalid_target", `This server's resource is ${resourceUrl(origin)}.`);
    const clientId = basic?.id ?? form.get("client_id") ?? "";
    if (/^https:\/\//.test(clientId)) await resolveClient(auth, clientId);
    const result = await auth.oauthToken({
      grantType: form.get("grant_type") ?? "",
      clientId,
      clientSecret: basic?.secret ?? form.get("client_secret"),
      code: form.get("code") ?? undefined,
      redirectUri: form.get("redirect_uri") ?? undefined,
      codeVerifier: form.get("code_verifier") ?? undefined,
      refreshToken: form.get("refresh_token") ?? undefined,
    });
    if (!result.ok) return oauthError(result.error, result.description, result.status);
    return json((result as unknown as { body: unknown }).body, 200, { Pragma: "no-cache" });
  }

  if (p === "/oauth/revoke" && m === "POST") {
    const form = await formBody(request);
    const token = form.get("token");
    if (token) await auth.oauthRevoke(token);
    return new Response(null, { status: 200, headers: CORS });
  }

  return oauthError("invalid_request", "Unknown OAuth endpoint.", 404);
}

// ---------------------------------------------------------------- helpers

async function formBody(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const j = (await request.json()) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(j ?? {}).map(([k, v]) => [k, String(v)]));
    }
    return new URLSearchParams(await request.text());
  } catch {
    return new URLSearchParams();
  }
}

function basicAuth(request: Request): { id: string; secret: string } | null {
  const h = request.headers.get("Authorization") ?? "";
  if (!h.startsWith("Basic ")) return null;
  try {
    const [id, secret] = atob(h.slice(6)).split(":");
    return { id: decodeURIComponent(id), secret: decodeURIComponent(secret ?? "") };
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https anywhere; http only back to this computer; an app's own scheme (cursor://…) but never script-like ones. */
function validRedirect(u: unknown): boolean {
  if (typeof u !== "string" || u.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:"].includes(url.protocol);
}

/** Exact match, except that an address on this computer may use any port (RFC 8252). */
function sameRedirect(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const a = new URL(registered);
    const b = new URL(asked);
    return a.protocol === "http:" && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && b.protocol === "http:";
  } catch {
    return false;
  }
}

function validResource(resource: string, origin: string) {
  const r = resource.replace(/\/+$/, "");
  return r === resourceUrl(origin) || r === origin;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

/** A registered app, or one identified by its metadata document's address (fetched and checked each time). */
async function resolveClient(auth: Auth, clientId: string) {
  if (!/^https:\/\/[^/]+\/./.test(clientId)) return auth.oauthClient(clientId);
  try {
    // Workers reject redirect: "error"; "manual" hands back a redirect as a 3xx, which fails the status check below.
    const res = await fetch(clientId, {
      headers: { Accept: "application/json", "User-Agent": "Sandpiper-OAuth/1" },
      redirect: "manual",
      cf: { cacheTtl: 300 },
    } as RequestInit);
    if (res.status !== 200) {
      console.warn("client metadata fetch failed", clientId, res.status);
      return null;
    }
    const text = await res.text();
    if (text.length > 20_000) return null;
    const meta = JSON.parse(text);
    if (meta?.client_id !== clientId || !Array.isArray(meta.redirect_uris) || !meta.redirect_uris.every(validRedirect)) {
      console.warn("client metadata rejected", clientId);
      return null;
    }
    await auth.oauthSaveMetadataClient({
      id: clientId,
      name: String(meta.client_name ?? "").slice(0, 100) || hostOf(clientId),
      uri: typeof meta.client_uri === "string" && /^https:\/\//.test(meta.client_uri) ? meta.client_uri.slice(0, 500) : null,
      redirectUris: meta.redirect_uris.slice(0, 10),
    });
    return auth.oauthClient(clientId);
  } catch (e) {
    console.warn("client metadata error", clientId, String(e));
    return null;
  }
}
