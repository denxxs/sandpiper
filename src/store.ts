// Shared workspace state. Everything here lives in one Yjs document per workspace (its page tree)
// that is synced between all connected clients, so the page tree, database
// schemas, rows and cell values are all collaborative. A tab shows one workspace (see nav.ts).
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { useCallback, useSyncExternalStore } from "react";
import { roomName, workspacePath, WS_ID } from "./nav";

export const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;

// ---------------------------------------------------------------- types
//
// Pages, databases, properties and views are described in shared/db.ts, which the server uses too.

import {
  asArray,
  backfillIds,
  convertValues,
  dbCtx,
  DbFilter,
  DbProperty,
  DbView,
  newRowIds,
  OPTION_COLORS,
  Page,
  Pages,
  PROP_TYPE_LABEL,
  PropOption,
  PropType,
  relationEcho,
  statusOptions,
  User,
  VIEW_LABEL,
  ViewType,
  ymd,
} from "../shared/db";
export type { DbFilter, DbFilterGroup, DbProperty, DbSort, DbView, FilterItem, Page, Pages, PropOption, PropType, User, ViewType } from "../shared/db";
export { OPTION_COLORS, PROP_TYPE_LABEL } from "../shared/db";

// ---------------------------------------------------------------- ids, colors

export function nid(len = 12): string {
  const a = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of a) s += "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36];
  return s;
}

export const USER_COLORS = ["#3b5bdb", "#0c8599", "#7048e8", "#c2255c", "#e8590c", "#5f3dc4", "#1971c2", "#a61e4d", "#d9480f", "#087f5b"];

// ---------------------------------------------------------------- local (per-browser) state

const localListeners = new Map<string, Set<() => void>>();
const localCache = new Map<string, any>();

function readLocal<T>(key: string, fallback: T): T {
  if (localCache.has(key)) return localCache.get(key);
  let value = fallback;
  try {
    const raw = localStorage.getItem("sandpiper." + key);
    if (raw != null) value = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  localCache.set(key, value);
  return value;
}
export function setLocal<T>(key: string, value: T) {
  localCache.set(key, value);
  try {
    localStorage.setItem("sandpiper." + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
  localListeners.get(key)?.forEach((l) => l());
}
export function getLocal<T>(key: string, fallback: T): T {
  return readLocal(key, fallback);
}
export function useLocal<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (l: () => void) => {
      let set = localListeners.get(key);
      if (!set) localListeners.set(key, (set = new Set()));
      set.add(l);
      return () => void set!.delete(l);
    },
    [key],
  );
  const value = useSyncExternalStore(subscribe, () => readLocal(key, fallback));
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      const next = typeof v === "function" ? (v as (p: T) => T)(readLocal(key, fallback)) : v;
      setLocal(key, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

// ---------------------------------------------------------------- workspace doc

export const wsDoc = new Y.Doc();
// Connects only once the person is signed in and known to be in this workspace (see loadSession below).
export const wsProvider = new WebsocketProvider(WS_URL, roomName("workspace"), wsDoc, { connect: false });
export const yPages = wsDoc.getMap<Y.Map<any>>("pages");
export const yMeta = wsDoc.getMap<any>("meta");
export const yUsers = wsDoc.getMap<User>("users");

function makeStore<T>(compute: () => T, bind: (onChange: () => void) => void) {
  let snapshot = compute();
  const listeners = new Set<() => void>();
  bind(() => {
    snapshot = compute();
    listeners.forEach((l) => l());
  });
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  };
  return { get: () => snapshot, use: () => useSyncExternalStore(subscribe, () => snapshot) };
}

const pagesStore = makeStore<Pages>(
  () => yPages.toJSON() as Pages,
  (cb) => yPages.observeDeep(cb),
);
export const usePages = pagesStore.use;
export const getPages = pagesStore.get;

const metaStore = makeStore<{ name?: string; icon?: string }>(
  () => yMeta.toJSON(),
  (cb) => yMeta.observe(cb),
);
export const useWorkspaceMeta = metaStore.use;

const usersStore = makeStore<Record<string, User>>(
  () => yUsers.toJSON(),
  (cb) => yUsers.observe(cb),
);
export const useUsers = usersStore.use;
export const getUsers = usersStore.get;

// True once the workspace has loaded, and it stays true: a dropped connection later on must not send the app back
// to the loading screen. Edits keep working locally and sync when the connection returns (the top bar says Offline).
let everSynced = false;
const syncedStore = makeStore<boolean>(
  () => (everSynced ||= wsProvider.synced),
  (cb) => wsProvider.on("sync", cb),
);
export const useSynced = syncedStore.use;

const statusStore = makeStore<boolean>(
  () => wsProvider.wsconnected,
  (cb) => wsProvider.on("status", cb),
);
export const useOnline = statusStore.use;

// ---------------------------------------------------------------- account & presence
//
// Who you are comes from the server (Google or passkey sign-in): name, colour and photo are
// stored with the account, so they're the same on every device. The live connection opens
// only once you're signed in.

export interface Me extends User {
  email: string;
  avatar: string | null;
  role: "owner" | "member";
}
export type AuthState = { status: "loading" } | { status: "signed-out"; error?: string } | { status: "signed-in"; user: Me };

let auth: AuthState = { status: "loading" };
const authListeners = new Set<() => void>();
function setAuth(next: AuthState) {
  auth = next;
  if (next.status === "signed-in") {
    publishMe();
    if (!wsProvider.shouldConnect) wsProvider.connect();
  } else if (next.status === "signed-out") {
    wsProvider.disconnect();
  }
  authListeners.forEach((l) => l());
}
const subscribeAuth = (l: () => void) => {
  authListeners.add(l);
  return () => void authListeners.delete(l);
};
export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, () => auth);
}
export function getMe(): Me | null {
  return auth.status === "signed-in" ? auth.user : null;
}
export function useMe(): Me | null {
  const a = useAuth();
  return a.status === "signed-in" ? a.user : null;
}

const LOGIN_ERRORS: Record<string, string> = {
  not_allowed: "That Google account isn't a member of this workspace. Ask the owner to add it in Settings → Members.",
  google_cancelled: "Google sign-in was cancelled.",
  expired: "Sign-in took too long. Try again.",
  google_not_configured: "Google sign-in isn't set up on the server yet.",
  google_failed: "Google sign-in didn't complete. Try again.",
};

// ---------------------------------------------------------------- workspaces

export interface WorkspaceMember {
  email: string;
  user: { id: string; name: string; color: string; avatar: string | null } | null;
}
export interface Workspace {
  id: string;
  name: string | null;
  icon: string | null;
  /** Email of the person who manages it. */
  owner: string;
  isOwner: boolean;
  createdAt: number;
  members: WorkspaceMember[];
}

let workspaces: Workspace[] = [];
const workspaceListeners = new Set<() => void>();
function setWorkspaces(list: Workspace[]) {
  workspaces = list;
  workspaceListeners.forEach((l) => l());
}
const subscribeWorkspaces = (l: () => void) => {
  workspaceListeners.add(l);
  return () => void workspaceListeners.delete(l);
};
export function useWorkspaces(): Workspace[] {
  return useSyncExternalStore(subscribeWorkspaces, () => workspaces);
}
export function getWorkspaces(): Workspace[] {
  return workspaces;
}
/** The workspace this tab shows. */
export function useCurrentWorkspace(): Workspace | null {
  return useWorkspaces().find((w) => w.id === WS_ID) ?? null;
}
export async function refreshWorkspaces(): Promise<Workspace[]> {
  const res = await fetch("/api/workspaces");
  if (res.ok) setWorkspaces((await res.json()).workspaces);
  return workspaces;
}
function replaceWorkspace(w: Workspace) {
  setWorkspaces(workspaces.map((x) => (x.id === w.id ? w : x)));
}

async function workspaceRequest(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Something went wrong. Try again.");
  return data;
}
export async function createWorkspace(p: { name: string; icon: string | null; members: string[] }): Promise<Workspace> {
  const { workspace } = await workspaceRequest("/api/workspaces", "POST", p);
  setWorkspaces([...workspaces, workspace]);
  return workspace;
}
/** Renames or re-icons a workspace. For this tab's workspace the change also goes into the live document. */
export async function updateWorkspace(id: string, patch: { name?: string; icon?: string | null }) {
  if (id === WS_ID) {
    wsDoc.transact(() => {
      if (patch.name !== undefined) yMeta.set("name", patch.name);
      if (patch.icon !== undefined) patch.icon ? yMeta.set("icon", patch.icon) : yMeta.delete("icon");
    });
  }
  replaceWorkspace((await workspaceRequest(`/api/workspaces/${id}`, "PATCH", patch)).workspace);
}
export async function setWorkspaceMembers(id: string, emails: string[]) {
  replaceWorkspace((await workspaceRequest(`/api/workspaces/${id}/members`, "PUT", { emails })).workspace);
}
export async function leaveWorkspace(id: string) {
  await workspaceRequest(`/api/workspaces/${id}/leave`, "POST");
  location.replace("/");
}
export async function deleteWorkspace(id: string) {
  await workspaceRequest(`/api/workspaces/${id}`, "DELETE");
  location.replace("/");
}

/** Name and icon shown for this tab's workspace: the live document first, so a rename by someone else shows up at once. */
export function useWorkspaceName(): { name: string; icon: string | null } {
  const meta = useWorkspaceMeta();
  const ws = useCurrentWorkspace();
  return { name: meta.name || ws?.name || "Untitled workspace", icon: meta.icon ?? ws?.icon ?? null };
}

/** A one-time note shown after the app had to send you somewhere else (e.g. a workspace you're no longer in). */
const NOTICE_KEY = "sandpiper.notice";
export function takeNotice(): string | null {
  try {
    const n = sessionStorage.getItem(NOTICE_KEY);
    if (n) sessionStorage.removeItem(NOTICE_KEY);
    return n;
  } catch {
    return null;
  }
}
function leaveNotice(text: string) {
  try {
    sessionStorage.setItem(NOTICE_KEY, text);
  } catch {
    /* ignore */
  }
}

/**
 * Where this tab should be. A plain visit to the site opens the workspace you used last; an address for a
 * workspace you can't open falls back to one you can.
 */
function landing(list: Workspace[]): string | null {
  const ids = list.map((w) => w.id);
  const last = getLocal<string | null>("lastWorkspace", null);
  const plainVisit = WS_ID === "main" && !/^#\/?[a-z0-9]/i.test(location.hash);
  if (plainVisit && last && ids.includes(last)) return last;
  if (ids.includes(WS_ID)) return WS_ID;
  if (last && ids.includes(last)) return last;
  return ids[0] ?? null;
}

/** Asks the server who we are. Runs on start, and again whenever the live connection drops. */
export async function loadSession(): Promise<void> {
  // An error handed back by the Google sign-in redirect: show it once, then tidy the address bar.
  const params = new URLSearchParams(location.search);
  const code = params.get("login_error");
  if (code) {
    params.delete("login_error");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
  }
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const data = await res.json();
      setWorkspaces(data.workspaces ?? []);
      const target = landing(workspaces);
      if (target && target !== WS_ID) {
        // Not in this workspace (any more), or a plain visit that should reopen the last one. Stay on the loading screen.
        if (!workspaces.some((w) => w.id === WS_ID)) {
          wsProvider.disconnect();
          if (auth.status === "signed-in" || WS_ID !== "main") leaveNotice("You don't have access to that workspace, so Sandpiper opened one you're in.");
        }
        location.replace(workspacePath(target));
        return;
      }
      setLocal("lastWorkspace", WS_ID);
      return setAuth({ status: "signed-in", user: data.user });
    }
    if (res.status === 401) return setAuth({ status: "signed-out", error: code ? (LOGIN_ERRORS[code] ?? LOGIN_ERRORS.google_failed) : undefined });
    throw new Error(String(res.status));
  } catch {
    // Already signed in: keep working offline; the live connection retries by itself.
    if (auth.status === "signed-in") return;
    setAuth({ status: "signed-out", error: "Can't reach Sandpiper right now. Check your connection and try again." });
  }
}

export async function signOut(everywhere = false) {
  await fetch(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", { method: "POST" }).catch(() => {});
  // A full reload makes sure nothing from the workspace stays in memory.
  location.replace("/");
}

export async function updateProfile(patch: { name?: string; color?: string }) {
  const res = await fetch("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  if (res.status === 401) return void loadSession();
  if (!res.ok) throw new Error("Couldn't save your profile. Try again.");
  setAuth({ status: "signed-in", user: (await res.json()).user });
}

function publishMe() {
  const me = getMe();
  if (!me) return;
  const pub: User = { id: me.id, name: me.name, color: me.color, avatar: me.avatar };
  wsProvider.awareness.setLocalStateField("user", pub);
  if (wsProvider.synced) {
    const cur = yUsers.get(me.id);
    if (!cur || cur.name !== pub.name || cur.color !== pub.color || (cur.avatar ?? null) !== pub.avatar) yUsers.set(me.id, pub);
  }
}
wsProvider.on("sync", (synced: boolean) => synced && publishMe());

// If the live connection closes (for example this device was signed out from another one),
// check whether the session is still valid.
let closeCheck: ReturnType<typeof setTimeout> | null = null;
wsProvider.on("connection-close", () => {
  if (closeCheck || auth.status !== "signed-in") return;
  closeCheck = setTimeout(() => {
    closeCheck = null;
    loadSession();
  }, 1500);
});

export function setPresencePage(pageId: string | null) {
  wsProvider.awareness.setLocalStateField("pageId", pageId);
}

export interface Presence {
  clientId: number;
  user: User;
  pageId: string | null;
}
const presenceStore = makeStore<Presence[]>(
  () => {
    const out: Presence[] = [];
    wsProvider.awareness.getStates().forEach((s: any, clientId) => {
      if (s?.user && clientId !== wsDoc.clientID) out.push({ clientId, user: s.user, pageId: s.pageId ?? null });
    });
    return out;
  },
  (cb) => wsProvider.awareness.on("change", cb),
);
export const usePresence = presenceStore.use;

// ---------------------------------------------------------------- queries

export function sortPages(list: Page[]): Page[] {
  return list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}
export function childrenOf(pages: Pages, parentId: string | null): Page[] {
  return sortPages(Object.values(pages).filter((p) => p.parentId === parentId && !p.isRow && !p.trashed));
}
export function rowsOf(pages: Pages, dbId: string): Page[] {
  return sortPages(Object.values(pages).filter((p) => p.parentId === dbId && p.isRow && !p.trashed));
}
export function ancestorsOf(pages: Pages, id: string): Page[] {
  const out: Page[] = [];
  const seen = new Set<string>();
  let cur = pages[id]?.parentId;
  while (cur && pages[cur] && !seen.has(cur)) {
    seen.add(cur);
    out.unshift(pages[cur]);
    cur = pages[cur].parentId;
  }
  return out;
}
/** True if the page or any ancestor is in the trash (or its parent no longer exists). */
/** A page or row made a moment ago, here or by someone else, so it can ink in where it appears. A clock
 *  running ahead on the other device only makes its pages count as new for longer, never start counting later. */
export function isFresh(p: Page): boolean {
  return Date.now() - p.createdAt < 2500;
}

export function isTrashed(pages: Pages, id: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur) {
    const p: Page | undefined = pages[cur];
    if (!p || p.trashed || seen.has(cur)) return true;
    seen.add(cur);
    cur = p.parentId;
  }
  return false;
}
export function descendantsOf(pages: Pages, id: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const p of Object.values(pages)) {
    if (p.parentId) byParent.set(p.parentId, [...(byParent.get(p.parentId) ?? []), p.id]);
  }
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const c of byParent.get(pid) ?? []) {
      if (out.includes(c) || c === id) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(id);
  return out;
}
export function pageTitle(p?: Page | null): string {
  return p?.title?.trim() || "Untitled";
}

// ---------------------------------------------------------------- mutations

function nextOrder(parentId: string | null): number {
  let max = 0;
  for (const p of Object.values(getPages())) if (p.parentId === parentId) max = Math.max(max, p.order);
  return max + 1;
}

export function createPage(init: Partial<Page> & { parentId: string | null }): string {
  const id = init.id ?? nid();
  const now = Date.now();
  const me = getMe();
  const page: Page = {
    title: "",
    kind: "page",
    order: nextOrder(init.parentId),
    createdAt: now,
    updatedAt: now,
    createdBy: me?.id,
    updatedBy: me?.id,
    ...init,
    id,
  };
  // A new row gets the next number of each ID property its database has.
  const db = init.isRow && init.parentId ? getPages()[init.parentId] : undefined;
  const ids = db?.kind === "database" ? newRowIds(getPages(), db) : null;
  if (ids) page.props = { ...ids.props, ...(page.props ?? {}) };
  wsDoc.transact(() => {
    if (ids && db) yPages.get(db.id)?.set("properties", ids.properties);
    const m = new Y.Map<any>();
    for (const [k, v] of Object.entries(page)) {
      if (v === undefined) continue;
      if (k === "props") {
        const pm = new Y.Map<any>();
        for (const [pk, pv] of Object.entries(v as object)) pm.set(pk, pv);
        m.set("props", pm);
      } else m.set(k, v);
    }
    yPages.set(id, m);
  });
  return id;
}

export function updatePage(id: string, patch: Partial<Page>, touch = true) {
  const m = yPages.get(id);
  if (!m) return;
  wsDoc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) m.delete(k);
      else m.set(k, v);
    }
    if (touch) touchInTx(m);
  });
}
function touchInTx(m: Y.Map<any>) {
  m.set("updatedAt", Date.now());
  const me = getMe();
  if (me) m.set("updatedBy", me.id);
}
const lastTouch = new Map<string, number>();
/** Throttled "last edited" bump, used by the editor on content changes. */
export function touchPage(id: string) {
  const now = Date.now();
  if (now - (lastTouch.get(id) ?? 0) < 20_000) return;
  lastTouch.set(id, now);
  const m = yPages.get(id);
  if (m) wsDoc.transact(() => touchInTx(m));
}

function setPropInTx(m: Y.Map<any>, propId: string, value: any) {
  let props = m.get("props") as Y.Map<any> | undefined;
  if (!(props instanceof Y.Map)) {
    props = new Y.Map<any>();
    m.set("props", props);
  }
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) props.delete(propId);
  else props.set(propId, value);
  touchInTx(m);
}

export function setRowProp(rowId: string, propId: string, value: any) {
  const m = yPages.get(rowId);
  if (!m) return;
  const pages = getPages();
  const row = pages[rowId];
  const prop = row?.parentId ? pages[row.parentId]?.properties?.find((p) => p.id === propId) : undefined;
  // A two-way relation shows on the other database too: keep that side in step.
  const echo = prop?.type === "relation" ? relationEcho(pages, prop, rowId, asArray(row.props?.[propId]), asArray(value)) : [];
  wsDoc.transact(() => {
    setPropInTx(m, propId, value);
    for (const e of echo) {
      const other = yPages.get(e.rowId);
      if (other) setPropInTx(other, e.propId, e.value);
    }
  });
}

/** Presses a button property on a row: sets the values its actions name. */
export function pressButton(rowId: string, prop: DbProperty) {
  const me = getMe();
  const pages = getPages();
  const row = pages[rowId];
  const db = row?.parentId ? pages[row.parentId] : undefined;
  if (!row || !db) return;
  wsDoc.transact(() => {
    for (const a of prop.button?.actions ?? []) {
      const target = db.properties?.find((p) => p.id === a.propId);
      if (!target && a.propId !== "title") continue;
      const v = a.value;
      let value: any = v;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (v.clear) value = undefined;
        else if (v.toggle) value = row.props?.[a.propId] ? undefined : true;
        else if (v.now) value = target?.type === "date" ? ymd(new Date()) : value;
        else if (v.me) value = me ? [me.id] : undefined;
      }
      if (a.propId === "title") updatePage(rowId, { title: String(value ?? "") });
      else setRowProp(rowId, a.propId, value);
    }
  });
}

export function trashPage(id: string) {
  updatePage(id, { trashed: true, trashedAt: Date.now() }, false);
}
export function restorePage(id: string) {
  const pages = getPages();
  const p = pages[id];
  if (!p) return;
  const patch: Partial<Page> = { trashed: undefined, trashedAt: undefined };
  // If the original parent is gone or itself trashed, restore to the top level.
  if (p.parentId && isTrashed(pages, p.parentId)) {
    patch.parentId = null;
    patch.isRow = undefined;
    patch.order = nextOrder(null);
  }
  const m = yPages.get(id);
  if (!m) return;
  wsDoc.transact(() => {
    m.delete("trashed");
    m.delete("trashedAt");
    if (patch.parentId === null) {
      m.set("parentId", null);
      m.delete("isRow");
      m.set("order", patch.order);
    }
  });
}
export function deleteForever(id: string) {
  const ids = [id, ...descendantsOf(getPages(), id)];
  wsDoc.transact(() => ids.forEach((i) => yPages.delete(i)));
  for (const i of ids) fetch(`/api/doc?room=${roomName("page-" + i)}`, { method: "DELETE" }).catch(() => {});
}

// ---------------------------------------------------------------- nesting depth
//
// Pages can nest, but not without end: past a few levels a tree stops being a structure and becomes a tunnel,
// and both the sidebar and the breadcrumbs run out of room. A page at MAX_DEPTH can't hold pages of its own.
// Database rows are records rather than structure, so a database can always take more rows.

export const MAX_DEPTH = 8;

/** 1 for a page at the top level, 2 for a page inside it, and so on. */
export function depthOf(pages: Pages, id: string): number {
  return ancestorsOf(pages, id).length + 1;
}
/** How many levels a page and the pages inside it take up (rows of its databases aside). */
function heightOf(pages: Pages, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let h = 1;
  for (const p of Object.values(pages)) if (p.parentId === id && !p.isRow) h = Math.max(h, 1 + heightOf(pages, p.id, seen));
  return h;
}
/** True if a new page can go inside this one (null is the top level). */
export function canNestIn(pages: Pages, parentId: string | null): boolean {
  return !parentId || !pages[parentId] || depthOf(pages, parentId) < MAX_DEPTH;
}
/** True if a page, with everything inside it, can move under this parent without going past the limit. */
export function canMoveInto(pages: Pages, id: string, parentId: string | null): boolean {
  if (!parentId || pages[parentId]?.kind === "database") return true;
  return depthOf(pages, parentId) + heightOf(pages, id) <= MAX_DEPTH;
}
/**
 * Creates a page "inside" another. When that page is already as deep as pages go, the new page goes next to it
 * instead, so asking for a page never hits a dead end. Returns the new id and whether it went inside.
 */
export function createPageInside(parentId: string, init: Partial<Page> = {}): { id: string; nested: boolean } {
  const pages = getPages();
  const nested = canNestIn(pages, parentId);
  if (nested) return { id: createPage({ ...init, parentId }), nested };
  // Right after the page it was asked for, rather than at the end of the list.
  const here = pages[parentId];
  return { id: createPage({ order: (here?.order ?? 0) + 0.5, ...init, parentId: here?.parentId ?? null }), nested };
}

export function movePage(id: string, parentId: string | null, order?: number): boolean {
  const pages = getPages();
  if (id === parentId) return false;
  if (parentId && descendantsOf(pages, id).includes(parentId)) return false;
  if (!canMoveInto(pages, id, parentId)) return false;
  const target = parentId ? pages[parentId] : null;
  const isRow = !!target && target.kind === "database";
  const m = yPages.get(id);
  if (!m) return false;
  wsDoc.transact(() => {
    m.set("parentId", parentId);
    m.set("order", order ?? nextOrder(parentId));
    if (isRow) m.set("isRow", true);
    else m.delete("isRow");
  });
  return true;
}

export async function duplicatePage(id: string): Promise<string | null> {
  const pages = getPages();
  const root = pages[id];
  if (!root) return null;
  const ids = [id, ...descendantsOf(pages, id)].filter((i) => !pages[i].trashed || i === id);
  const map = new Map(ids.map((i) => [i, nid()]));
  await Promise.all(
    ids.map((i) => fetch(`/api/copy?from=${roomName("page-" + i)}&to=${roomName("page-" + map.get(i))}`, { method: "POST" }).catch(() => {})),
  );
  wsDoc.transact(() => {
    for (const i of ids) {
      const p = pages[i];
      createPage({
        ...p,
        id: map.get(i)!,
        title: i === id ? `${pageTitle(p)} (copy)` : p.title,
        parentId: i === id ? p.parentId : (map.get(p.parentId!) ?? p.parentId),
        order: i === id ? p.order + 0.5 : p.order,
        trashed: undefined,
        trashedAt: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });
  return map.get(id)!;
}

// ---------------------------------------------------------------- databases

export function defaultDatabase(view: ViewType = "table"): Pick<Page, "kind" | "properties" | "views"> {
  const status: DbProperty = { id: nid(6), name: "Status", type: "status", options: statusOptions(nid) };
  const tags: DbProperty = { id: nid(6), name: "Tags", type: "multi_select", options: [] };
  const date: DbProperty = { id: nid(6), name: "Date", type: "date" };
  const properties = view === "board" ? [status, tags, date] : view === "calendar" || view === "timeline" ? [date, tags, status] : [tags, status, date];
  return {
    kind: "database",
    properties,
    views: [newView(view, properties)],
  };
}

export function newView(type: ViewType, properties: DbProperty[], name?: string): DbView {
  const v: DbView = { id: nid(6), name: name ?? VIEW_LABEL[type], type, filters: [], sorts: [] };
  const groupable = properties.find((p) => p.type === "status") ?? properties.find((p) => p.type === "select");
  if (type === "board") v.groupBy = groupable?.id;
  if (type === "calendar" || type === "timeline") v.dateProp = properties.find((p) => p.type === "date")?.id;
  if (type === "chart") v.chart = { type: "bar", x: groupable?.id ?? properties.find((p) => ["multi_select", "person", "checkbox"].includes(p.type))?.id, y: { fn: "count" } };
  return v;
}

export function updateView(dbId: string, viewId: string, patch: Partial<DbView>) {
  const db = getPages()[dbId];
  if (!db?.views) return;
  updatePage(dbId, { views: db.views.map((v) => (v.id === viewId ? clean({ ...v, ...patch }) : v)) }, false);
}
/** Drops settings set to undefined, so they don't linger as nulls in the shared document. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

export function updateProperty(dbId: string, propId: string, patch: Partial<DbProperty>) {
  const db = getPages()[dbId];
  if (!db?.properties) return;
  const old = db.properties.find((p) => p.id === propId);
  if (!old) return;
  const next = clean({ ...old, ...patch });
  // Changing type: bring along what the new type needs, and convert the values rows already have.
  if (patch.type && patch.type !== old.type) {
    const { values, options } = convertValues(db, old, patch.type, dbCtx(getPages(), getUsers()), nid);
    if (options) next.options = options;
    if (["select", "multi_select", "status"].includes(patch.type) && !next.options) next.options = [];
    if (patch.type === "status") {
      next.options = next.options!.length ? next.options!.map((o) => ({ ...o, group: o.group ?? "todo" })) : statusOptions(nid);
    }
    if (patch.type !== "unique_id" && Object.keys(values).length) {
      wsDoc.transact(() => {
        updatePage(dbId, { properties: db.properties!.map((p) => (p.id === propId ? next : p)) }, false);
        for (const [rowId, value] of Object.entries(values)) {
          const m = yPages.get(rowId);
          if (m) setPropInTx(m, propId, value);
        }
      });
      return;
    }
    if (patch.type === "unique_id") {
      const { ids, next: n } = backfillIds(getPages(), dbId, propId);
      next.nextId = n;
      wsDoc.transact(() => {
        updatePage(dbId, { properties: db.properties!.map((p) => (p.id === propId ? next : p)) }, false);
        for (const [rowId, value] of Object.entries(ids)) {
          const m = yPages.get(rowId);
          if (m) setPropInTx(m, propId, value);
        }
      });
      return;
    }
  }
  updatePage(dbId, { properties: db.properties.map((p) => (p.id === propId ? next : p)) }, false);
}

/** A name not yet used on this database: "Status", then "Status 2". */
function freeName(existing: DbProperty[], base: string) {
  let n = base;
  for (let i = 2; existing.some((p) => p.name === n); i++) n = `${base} ${i}`;
  return n;
}

/** Adds a property; `at` puts it at that place among the properties (end by default). Returns its id. */
export function addProperty(dbId: string, type: PropType = "text", name?: string, extra: Partial<DbProperty> = {}, at?: number): string {
  const pages = getPages();
  const db = pages[dbId];
  const id = nid(6);
  const existing = db?.properties ?? [];
  const prop: DbProperty = { id, name: freeName(existing, name ?? PROP_TYPE_LABEL[type]), type, ...extra };
  if ((type === "select" || type === "multi_select") && !prop.options) prop.options = [];
  if (type === "status" && !prop.options) prop.options = statusOptions(nid);
  if (type === "formula" && prop.formula == null) prop.formula = "";
  if (type === "button" && !prop.button) prop.button = { label: "Button", actions: [] };
  const list = [...existing];
  list.splice(at == null ? list.length : Math.max(0, Math.min(list.length, at)), 0, prop);
  wsDoc.transact(() => {
    if (type === "unique_id") {
      const { ids, next } = backfillIds(pages, dbId, id);
      prop.nextId = next;
      for (const [rowId, value] of Object.entries(ids)) {
        const m = yPages.get(rowId);
        if (m) setPropInTx(m, id, value);
      }
    }
    // A two-way relation adds its mirror on the other database.
    if (type === "relation" && prop.relation?.dbId && prop.relation.syncedPropId === "new") {
      const target = pages[prop.relation.dbId];
      const mirrorId = nid(6);
      prop.relation = { dbId: prop.relation.dbId, syncedPropId: mirrorId };
      if (target && target.id !== dbId) {
        const mirror: DbProperty = { id: mirrorId, name: freeName(target.properties ?? [], pageTitle(db)), type: "relation", relation: { dbId, syncedPropId: id } };
        updatePage(target.id, { properties: [...(target.properties ?? []), mirror] }, false);
      } else if (target) {
        const mirror: DbProperty = { id: mirrorId, name: freeName(list, "Related " + prop.name), type: "relation", relation: { dbId, syncedPropId: id } };
        list.push(mirror);
      }
    }
    updatePage(dbId, { properties: list }, false);
  });
  return id;
}

/** A copy of a property placed right after it, with every row's value copied too. */
export function duplicateProperty(dbId: string, propId: string): string | null {
  const pages = getPages();
  const db = pages[dbId];
  const src = db?.properties?.find((p) => p.id === propId);
  if (!db || !src) return null;
  const at = db.properties!.indexOf(src) + 1;
  const copy: DbProperty = { ...src, id: nid(6), name: freeName(db.properties!, src.name + " (copy)") };
  // A copied relation is one-way: the other side mirrors only the original.
  if (copy.relation) copy.relation = { dbId: copy.relation.dbId };
  const list = [...db.properties!];
  list.splice(at, 0, copy);
  wsDoc.transact(() => {
    updatePage(dbId, { properties: list }, false);
    if (src.type !== "unique_id") {
      for (const r of Object.values(pages)) {
        if (r.parentId !== dbId || !r.isRow || r.props?.[propId] === undefined) continue;
        const m = yPages.get(r.id);
        if (m) setPropInTx(m, copy.id, r.props[propId]);
      }
    }
  });
  return copy.id;
}

/** Moves a property to a new place among the database's properties. */
export function moveProperty(dbId: string, propId: string, to: number) {
  const db = getPages()[dbId];
  const list = [...(db?.properties ?? [])];
  const from = list.findIndex((p) => p.id === propId);
  if (from < 0) return;
  const [p] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, p);
  updatePage(dbId, { properties: list }, false);
}

export function deleteProperty(dbId: string, propId: string) {
  const pages = getPages();
  const db = pages[dbId];
  if (!db) return;
  const prop = db.properties?.find((p) => p.id === propId);
  const dropFilter = (f: any): boolean => (f.group ? true : f.propId !== propId);
  const views = (db.views ?? []).map((v) =>
    clean({
      ...v,
      filters: v.filters.filter(dropFilter).map((f: any) => (f.group ? { ...f, filters: f.filters.filter((x: DbFilter) => x.propId !== propId) } : f)),
      sorts: v.sorts.filter((s) => s.propId !== propId),
      groupBy: v.groupBy === propId ? undefined : v.groupBy,
      dateProp: v.dateProp === propId ? undefined : v.dateProp,
      endProp: v.endProp === propId ? undefined : v.endProp,
      hidden: v.hidden?.filter((x) => x !== propId),
      wrapCols: v.wrapCols?.filter((x) => x !== propId),
      calcs: v.calcs ? Object.fromEntries(Object.entries(v.calcs).filter(([k]) => k !== propId)) : undefined,
      chart: v.chart ? clean({ ...v.chart, x: v.chart.x === propId ? undefined : v.chart.x, stack: v.chart.stack === propId ? undefined : v.chart.stack, y: v.chart.y?.propId === propId ? { fn: "count" } : v.chart.y }) : undefined,
    }),
  );
  wsDoc.transact(() => {
    updatePage(dbId, { properties: (db.properties ?? []).filter((p) => p.id !== propId), views }, false);
    // The mirror of a two-way relation stays, as a one-way relation.
    const synced = prop?.relation?.syncedPropId;
    const other = prop?.relation ? getPages()[prop.relation.dbId] : undefined;
    if (synced && other) {
      updatePage(other.id, { properties: (other.properties ?? []).map((p) => (p.id === synced ? { ...p, relation: { dbId: p.relation!.dbId } } : p)) }, false);
    }
  });
}

/** Turns a one-way relation two-way (adds its mirror on the other database), or back. */
export function setRelationTwoWay(dbId: string, propId: string, on: boolean) {
  const pages = getPages();
  const db = pages[dbId];
  const prop = db?.properties?.find((p) => p.id === propId);
  if (!db || !prop?.relation) return;
  const target = pages[prop.relation.dbId];
  if (!target) return;
  wsDoc.transact(() => {
    if (on && !prop.relation!.syncedPropId) {
      const mirrorId = nid(6);
      const mirror: DbProperty = { id: mirrorId, name: freeName(target.properties ?? [], pageTitle(db)), type: "relation", relation: { dbId, syncedPropId: propId } };
      if (target.id === dbId) {
        updatePage(dbId, { properties: [...db.properties!.map((p) => (p.id === propId ? { ...p, relation: { dbId, syncedPropId: mirrorId } } : p)), mirror] }, false);
      } else {
        updatePage(target.id, { properties: [...(target.properties ?? []), mirror] }, false);
        updateProperty(dbId, propId, { relation: { dbId: target.id, syncedPropId: mirrorId } });
      }
      // Fill the mirror from what's already related.
      const back = new Map<string, string[]>();
      for (const r of Object.values(pages)) {
        if (r.parentId !== dbId || !r.isRow) continue;
        for (const other of asArray(r.props?.[propId])) back.set(other, [...(back.get(other) ?? []), r.id]);
      }
      for (const [other, ids] of back) {
        const m = yPages.get(other);
        if (m) setPropInTx(m, mirrorId, ids);
      }
    } else if (!on && prop.relation!.syncedPropId) {
      const synced = prop.relation!.syncedPropId;
      updateProperty(dbId, propId, { relation: { dbId: target.id } });
      const t = getPages()[target.id];
      updatePage(target.id, { properties: (t.properties ?? []).filter((p) => p.id !== synced) }, false);
    }
  });
}

/** Adds an option to a select, multi-select or status property and returns its id. */
export function addOption(dbId: string, propId: string, name: string, group?: PropOption["group"]): string {
  const db = getPages()[dbId];
  const prop = db?.properties?.find((p) => p.id === propId);
  const existing = prop?.options ?? [];
  const found = existing.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
  if (found) return found.id;
  const opt: PropOption = { id: nid(6), name: name.trim(), color: OPTION_COLORS[(existing.length + 5) % OPTION_COLORS.length] };
  if (prop?.type === "status") opt.group = group ?? "todo";
  updateProperty(dbId, propId, { options: [...existing, opt] });
  return opt.id;
}

// ---------------------------------------------------------------- first-run content

export function seedIfEmpty() {
  if (yPages.size > 0 || yMeta.get("seeded")) return;
  // A workspace made from the switcher starts with its name and a single welcome page; no sample data.
  if (WS_ID !== "main") {
    const ws = getWorkspaces().find((w) => w.id === WS_ID);
    wsDoc.transact(() => {
      yMeta.set("seeded", true);
      if (ws?.name) yMeta.set("name", ws.name);
      if (ws?.icon) yMeta.set("icon", ws.icon);
      createPage({ parentId: null, title: "Getting Started", icon: "👋", cover: "g:2", template: "welcome", order: 1 });
    });
    return;
  }
  wsDoc.transact(() => {
    yMeta.set("seeded", true);
    yMeta.set("name", "My Workspace");
    createPage({ parentId: null, title: "Getting Started", icon: "👋", cover: "g:2", template: "welcome", order: 1 });

    const db = defaultDatabase("table");
    const props = db.properties!;
    const status = props.find((p) => p.name === "Status")!;
    const tags = props.find((p) => p.name === "Tags")!;
    const date = props.find((p) => p.name === "Date")!;
    tags.options = [
      { id: nid(6), name: "Design", color: "purple" },
      { id: nid(6), name: "Engineering", color: "blue" },
      { id: nid(6), name: "Writing", color: "orange" },
    ];
    db.views = [newView("table", props, "All tasks"), newView("board", props, "By status"), newView("calendar", props, "Calendar")];
    const dbId = createPage({ parentId: null, title: "Tasks", icon: "✅", order: 2, ...db });
    const day = (offset: number) => {
      const d = new Date(Date.now() + offset * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const rows: [string, number, number[], number][] = [
      ["Sketch the new onboarding flow", 1, [0], 1],
      ["Write the launch announcement", 0, [2], 3],
      ["Fix sync bug on slow connections", 1, [1], 0],
      ["Set up the project workspace", 2, [1, 0], -2],
    ];
    rows.forEach(([title, s, t, d], i) =>
      createPage({
        parentId: dbId,
        isRow: true,
        title,
        order: i + 1,
        props: { [status.id]: status.options![s].id, [tags.id]: t.map((x) => tags.options![x].id), [date.id]: day(d) },
      }),
    );
    createPage({ parentId: null, title: "Meeting Notes", icon: "📝", template: "meeting", order: 3 });
  });
}
