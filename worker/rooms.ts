// Which workspace a live-sync room, a search index or a file belongs to.
//
// The original workspace ("main") keeps the room names it has always had, so its data and links are untouched:
//   main:        "workspace", "page-<pageId>"
//   any other:   "w_<workspaceId>_workspace", "w_<workspaceId>_page-<pageId>"

/** "main", or a 10-character id for every workspace created since. */
export const WS_ID_RE = /^(main|[a-z0-9]{10})$/;

const MAIN_ROOM = /^(workspace|page-([A-Za-z0-9]{1,40}))$/;
const WS_ROOM = /^w_([a-z0-9]{10})_(workspace|page-([A-Za-z0-9]{1,40}))$/;

/** The workspace a room belongs to, or null if the name isn't a room at all. */
export function roomWorkspace(room: string): string | null {
  if (MAIN_ROOM.test(room)) return "main";
  return WS_ROOM.exec(room)?.[1] ?? null;
}

/** The page id of a page room ("page-abc" or "w_…_page-abc"), or null for a workspace room. */
export function roomPageId(room: string): string | null {
  return MAIN_ROOM.exec(room)?.[2] ?? WS_ROOM.exec(room)?.[3] ?? null;
}

export function roomName(ws: string, name: string): string {
  return ws === "main" ? name : `w_${ws}_${name}`;
}

/** Each workspace has its own search index; the original one keeps its old name. */
export function searchName(ws: string): string {
  return ws === "main" ? "index" : `index_${ws}`;
}
