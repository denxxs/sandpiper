// Routing. The workspace is in the path ("/w/<id>/", or "/" for the original workspace) and the page in the hash:
//   #/<pageId>  and optionally  #/<pageId>?p=<rowId> for the side peek (&m=c: in the middle of the screen), and
//   ?b=<blockId> to scroll to one block of the page.
// Switching workspace loads the page afresh, so everything in memory belongs to exactly one workspace.
import { useSyncExternalStore } from "react";

/** The workspace this tab shows. "main" is the original one, which keeps its old addresses. */
export const WS_ID: string = /^\/w\/([a-z0-9]{10})(\/|$)/.exec(location.pathname)?.[1] ?? "main";

export function workspacePath(id: string): string {
  return id === "main" ? "/" : `/w/${id}/`;
}
/** Live-sync room names; must match worker/rooms.ts. */
export function roomName(name: string): string {
  return WS_ID === "main" ? name : `w_${WS_ID}_${name}`;
}

export interface Route {
  pageId: string | null;
  peek: string | null;
  peekMode: "side" | "center";
  block: string | null;
}

let cached: Route = parse();
let cachedHash = location.hash;

function parse(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [id, query] = raw.split("?");
  const q = new URLSearchParams(query ?? "");
  const peek = q.get("p");
  const block = q.get("b");
  return {
    pageId: /^[a-z0-9]+$/i.test(id) ? id : null,
    peek: peek && /^[a-z0-9]+$/i.test(peek) ? peek : null,
    peekMode: q.get("m") === "c" ? "center" : "side",
    block: block && /^[A-Za-z0-9_-]+$/.test(block) ? block : null,
  };
}
function get(): Route {
  if (location.hash !== cachedHash) {
    cachedHash = location.hash;
    cached = parse();
  }
  return cached;
}
function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, get);
}
export function go(pageId: string | null) {
  location.hash = pageId ? "#/" + pageId : "#/";
}
export function openPeek(rowId: string | null, mode: "side" | "center" = "side") {
  const { pageId } = get();
  if (!pageId) return go(rowId);
  location.hash = "#/" + pageId + (rowId ? "?p=" + rowId + (mode === "center" ? "&m=c" : "") : "");
}
/** Opens a database row the way its view says: side peek, centre peek, or as a full page. */
export function openRow(rowId: string, how: "side" | "center" | "full" = "side") {
  if (how === "full") go(rowId);
  else openPeek(rowId, how);
}
/** The address of one block on a page. */
export function blockUrl(pageId: string, blockId: string): string {
  return `${location.origin}${workspacePath(WS_ID)}#/${pageId}?b=${blockId}`;
}
export function pageUrl(pageId: string): string {
  return `${location.origin}${workspacePath(WS_ID)}#/${pageId}`;
}
/** Opens another workspace (a fresh load). */
export function openWorkspace(id: string) {
  location.assign(workspacePath(id));
}
