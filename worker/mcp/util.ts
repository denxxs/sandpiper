// Small helpers shared by the MCP server's document code (which runs inside the document rooms) and its tools.
import { USER_ERROR } from "../errors";

/** Throws an error whose message is meant for the person (or the AI acting for them), not a stack trace. */
export function fail(message: string): never {
  throw new Error(USER_ERROR + message);
}

/** The person-facing part of an error, or null if it was an unexpected failure. */
export function userMessage(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const at = message.indexOf(USER_ERROR);
  return at >= 0 ? message.slice(at + USER_ERROR.length) : null;
}

export function nid(len = 12): string {
  const a = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of a) s += "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36];
  return s;
}

/** Who is making a change, so it can carry their name ("last edited by", comment authors). */
export interface OpCtx {
  userId: string;
}

/** Text colours and highlights the editor offers. */
export const COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
/** Colours for database options (tags). */
export const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
