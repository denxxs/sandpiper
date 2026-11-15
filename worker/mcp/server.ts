// Sandpiper's MCP server: POST /mcp, JSON-RPC over MCP's Streamable HTTP transport (plain JSON responses, no
// sessions). Every request carries a bearer token from OAuth or from Settings → AI & apps.
import type { AuthStore } from "../auth";
import type { Env } from "../index";
import { CORS, corsPreflight, resourceMetadataUrl } from "../oauth";
import { instructions, Tool, ToolCtx, TOOLS } from "./tools";
import { userMessage } from "./util";

type Auth = DurableObjectStub<AuthStore>;

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "sandpiper", title: "Sandpiper", version: "1.0.0" };

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" }), "Cache-Control": "no-store", ...CORS, ...headers },
  });

function unauthorized(origin: string, description: string) {
  return reply({ jsonrpc: "2.0", id: null, error: { code: -32001, message: description } }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl(origin)}", error="invalid_token", error_description="${description}"`,
  });
}

export async function handleMcp(request: Request, env: Env, auth: Auth, origin: string): Promise<Response> {
  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method !== "POST") {
    // No server-to-client stream: everything is request and response.
    return new Response("This MCP server answers POST requests only.", { status: 405, headers: { Allow: "POST, OPTIONS", ...CORS } });
  }

  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return unauthorized(origin, "Sign in to connect Sandpiper.");
  const who = await auth.aiAuth(token);
  if (!who) return unauthorized(origin, "This connection has expired or was removed. Connect again.");
  const ctx: ToolCtx = { env, auth, user: who.user, grant: who.grant, origin };

  let body: any;
  try {
    body = await request.json();
  } catch {
    return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  const out: unknown[] = [];
  for (const msg of messages) {
    const res = await handle(ctx, msg);
    if (res) out.push(res);
  }
  // Only notifications (or responses): nothing to say back.
  if (!out.length) return reply(null, 202);
  return reply(batch ? out : out[0]);
}

const available = (ctx: ToolCtx): Tool[] => (ctx.grant.access === "write" ? TOOLS : TOOLS.filter((t) => !t.write));

async function handle(ctx: ToolCtx, msg: any): Promise<unknown> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg && !("result" in msg) && !("error" in msg) ? { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Invalid request" } } : null;
  }
  const isNotification = !("id" in msg);
  const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
  const err = (code: number, message: string) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const params = msg.params ?? {};

  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: instructions(),
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: available(ctx).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            title: t.title,
            readOnlyHint: !t.write,
            destructiveHint: t.write ? !!t.destructive : undefined,
            idempotentHint: t.write ? !!t.idempotent : undefined,
            openWorldHint: false,
          },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return err(-32602, `Unknown tool: ${params.name}`);
      if (tool.write && ctx.grant.access !== "write") {
        return ok(toolError("This connection can only read. The person can allow editing in Sandpiper's Settings → AI & apps, or connect again and choose Read and edit."));
      }
      try {
        const result = await tool.run(ctx, params.arguments ?? {});
        return ok(toolResult(result));
      } catch (e) {
        const m = userMessage(e);
        if (m) return ok(toolError(m));
        console.error("MCP tool failed", tool.name, e);
        return ok(toolError("Something went wrong on Sandpiper's side. Try again."));
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "resources/templates/list":
      return ok({ resourceTemplates: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    case "logging/setLevel":
      return ok({});
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return err(-32601, `Method not found: ${msg.method}`);
  }
}

/** Results go to the model as text only (no structured copy, which some apps would pass along twice). */
function toolResult(result: unknown) {
  const data = (result ?? { ok: true }) as Record<string, unknown>;
  // Page content reads better as its own text than as an escaped JSON string.
  if (typeof data === "object" && typeof data.markdown === "string") {
    const { markdown, ...rest } = data;
    return {
      content: [
        { type: "text", text: JSON.stringify(rest) },
        { type: "text", text: markdown || "(This page has no content yet.)" },
      ],
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const toolError = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });
