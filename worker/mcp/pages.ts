// The page tree as plain data, with the same rules the app follows: nesting depth, trash, database rows. What
// database values mean, and how filters, sorts, grouping, formulas and rollups work, is in shared/db.ts, which the
// app uses too. Pure functions, used both inside the workspace's document room (to check a change before making
// it) and by the tools (to answer questions).
import {
  allProps,
  asArray,
  dateVal,
  DbCtx,
  DbFilter,
  DbFilterGroup,
  DbProperty,
  FilterItem,
  filesVal,
  formulaValue,
  isDate,
  isGroup,
  isPage,
  isPerson,
  kindOf,
  opsFor,
  Page,
  Pages,
  PROP_TYPE_LABEL,
  PropOption,
  RELATIVE_DAYS,
  relationIds,
  rollupValue,
  sortPages,
  storeDate,
  TITLE,
  uniqueId,
  User,
  WITHIN,
  ymd,
  FValue,
} from "../../shared/db";
import { fail, OPTION_COLORS } from "./util";

export * from "../../shared/db";

/** Someone in the workspace, for "person" values. */
export interface Person {
  id: string;
  name: string;
  email: string;
}

export const MAX_DEPTH = 8;
export const FONTS = ["default", "serif", "mono"] as const;
/** The app's preset covers: gradients g:1–g:9 and plain colours c:1–c:6. Anything else is an image address. */
export const COVER_PRESETS = [...Array.from({ length: 9 }, (_, i) => `g:${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `c:${i + 1}`)];
// ---------------------------------------------------------------- tree queries

export function childrenOf(pages: Pages, parentId: string | null): Page[] {
  return sortPages(Object.values(pages).filter((p) => p.parentId === parentId && !p.isRow && !p.trashed));
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
  for (const p of Object.values(pages)) if (p.parentId) byParent.set(p.parentId, [...(byParent.get(p.parentId) ?? []), p.id]);
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
export const pageTitle = (p?: Page | null) => p?.title?.trim() || "Untitled";
export const depthOf = (pages: Pages, id: string) => ancestorsOf(pages, id).length + 1;
function heightOf(pages: Pages, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let h = 1;
  for (const p of Object.values(pages)) if (p.parentId === id && !p.isRow) h = Math.max(h, 1 + heightOf(pages, p.id, seen));
  return h;
}
export function canNestIn(pages: Pages, parentId: string | null): boolean {
  return !parentId || !pages[parentId] || pages[parentId].kind === "database" || depthOf(pages, parentId) < MAX_DEPTH;
}
export function canMoveInto(pages: Pages, id: string, parentId: string | null): boolean {
  if (!parentId || pages[parentId]?.kind === "database") return true;
  return depthOf(pages, parentId) + heightOf(pages, id) <= MAX_DEPTH;
}
export function nextOrder(pages: Pages, parentId: string | null): number {
  let max = 0;
  for (const p of Object.values(pages)) if (p.parentId === parentId) max = Math.max(max, p.order);
  return max + 1;
}

/** An order that puts a page right after (or before) a sibling. */
export function orderNear(pages: Pages, parentId: string | null, ref: string, side: "after" | "before"): number {
  const r = pages[ref];
  if (!r || r.parentId !== parentId) fail(`The page ${ref} isn't in the same place, so the new position can't be next to it.`);
  const sibs = sortPages(Object.values(pages).filter((p) => p.parentId === parentId && !!p.isRow === !!r.isRow));
  const i = sibs.findIndex((p) => p.id === ref);
  const other = side === "after" ? sibs[i + 1] : sibs[i - 1];
  if (!other) return side === "after" ? r.order + 1 : r.order - 1;
  return (r.order + other.order) / 2;
}

/** A page that locks itself, or a row of a locked database: shown read-only in the app, and kept that way here. */
export function lockedBy(pages: Pages, id: string): Page | null {
  const p = pages[id];
  if (!p) return null;
  if (p.locked) return p;
  if (p.isRow && p.parentId && pages[p.parentId]?.locked) return pages[p.parentId];
  return null;
}

// ---------------------------------------------------------------- databases

export function propertyOf(db: Page, ref: string, allowTitle = true): DbProperty {
  const r = String(ref ?? "").trim();
  if (allowTitle && (r === "title" || r.toLowerCase() === "name")) {
    const named = (db.properties ?? []).find((p) => p.name.toLowerCase() === "name");
    if (!named || r === "title") return TITLE;
  }
  const props = db.properties ?? [];
  const found = props.find((p) => p.id === r) ?? props.find((p) => p.name === r) ?? props.find((p) => p.name.toLowerCase() === r.toLowerCase());
  if (!found) fail(`${pageTitle(db)} has no property "${ref}". Its properties: Name (the title), ${props.map((p) => p.name).join(", ") || "none other"}.`);
  return found;
}

// ---------------------------------------------------------------- reading values

/** A computed value in JSON: numbers, text, true/false, dates as YYYY-MM-DD (or with a time), lists, page titles. */
function plainF(v: FValue, c: DbCtx): unknown {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((x) => plainF(x, c));
  if (isDate(v)) {
    const one = (ms: number) => (v.time ? new Date(ms).toISOString() : ymd(ms));
    return v.end != null && v.end !== v.start ? { start: one(v.start), end: one(v.end) } : one(v.start);
  }
  if (isPage(v)) return c.pages[v.id]?.title?.trim() || "Untitled";
  if (isPerson(v)) return c.users[v.id]?.name ?? v.id;
  return v;
}

/** A row's value as people read it: option names, people's names, dates as YYYY-MM-DD, related pages, results. */
export function readableValue(row: Page, prop: DbProperty, c: DbCtx): unknown {
  const v = row.props?.[prop.id];
  switch (prop.type) {
    case "created_time":
      return new Date(row.createdAt).toISOString();
    case "last_edited_time":
      return new Date(row.updatedAt).toISOString();
    case "created_by":
      return row.createdBy ? (c.users[row.createdBy]?.name ?? row.createdBy) : null;
    case "last_edited_by":
      return row.updatedBy ? (c.users[row.updatedBy]?.name ?? row.updatedBy) : null;
    case "checkbox":
      return !!v;
    case "select":
    case "status":
      return asArray(v)
        .map((id) => prop.options?.find((o) => o.id === id)?.name)
        .find(Boolean) ?? null;
    case "multi_select":
      return asArray(v)
        .map((id) => prop.options?.find((o) => o.id === id)?.name)
        .filter(Boolean);
    case "person":
      return asArray(v).map((id) => c.users[id]?.name ?? id);
    case "number":
      return v == null || v === "" ? null : Number(v);
    case "date": {
      const d = dateVal(v);
      return d ? (d.end ? { start: d.start, end: d.end } : d.start) : null;
    }
    case "files":
      return filesVal(v);
    case "relation":
      return relationIds(row, prop, c).map((id) => ({ id, title: c.pages[id]?.title?.trim() || "Untitled" }));
    case "unique_id": {
      const n = uniqueId(row, prop, c);
      return prop.prefix ? `${prop.prefix}-${n}` : n;
    }
    case "rollup":
      return plainF(rollupValue(row, prop, c), c);
    case "formula": {
      const r = formulaValue(row, prop, c);
      return r.error ? { error: r.error } : plainF(r.value, c);
    }
    case "button":
      return undefined;
    default:
      return v == null || v === "" ? null : v;
  }
}

// ---------------------------------------------------------------- writing values

/** Finds an option by id or name; null if there isn't one. */
export function findOption(prop: DbProperty, ref: unknown): PropOption | null {
  const r = String(ref ?? "").trim();
  const opts = prop.options ?? [];
  return opts.find((o) => o.id === r) ?? opts.find((o) => o.name === r) ?? opts.find((o) => o.name.toLowerCase() === r.toLowerCase()) ?? null;
}

export function nextOptionColor(prop: DbProperty) {
  return OPTION_COLORS[((prop.options?.length ?? 0) + 5) % OPTION_COLORS.length];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
function dateText(s: unknown, label: string): string {
  const t = String(s ?? "").trim().replace(" ", "T").slice(0, 16);
  if (!DATE_RE.test(t) || Number.isNaN(Date.parse(t.slice(0, 10)))) fail(`${label} takes a date written YYYY-MM-DD (or YYYY-MM-DDTHH:MM with a time).`);
  return t;
}

/** Finds a person by id, email, name or first name. */
export function findPerson(people: Person[], x: unknown, label: string): string {
  const r = String(x).trim().toLowerCase();
  const hit =
    people.find((p) => p.id.toLowerCase() === r) ??
    people.find((p) => p.email.toLowerCase() === r) ??
    people.find((p) => p.name.toLowerCase() === r) ??
    people.find((p) => p.name.toLowerCase().split(" ")[0] === r);
  if (!hit) fail(`${label}: "${x}" isn't someone in this workspace. People here: ${people.map((p) => p.name).join(", ")}.`);
  return hit.id;
}

/** A row of a relation's database, by id or exact title. */
function findRelated(pages: Pages, prop: DbProperty, x: unknown, label: string): string {
  const dbId = prop.relation?.dbId;
  if (!dbId || !pages[dbId]) fail(`${label}: the database it relates to no longer exists.`);
  const rows = Object.values(pages).filter((p) => p.parentId === dbId && p.isRow && !p.trashed);
  const r = String(isObjLike(x) ? ((x as any).id ?? (x as any).title) : x).trim();
  const hit = rows.find((p) => p.id === r) ?? rows.find((p) => (p.title ?? "").trim() === r) ?? rows.find((p) => (p.title ?? "").trim().toLowerCase() === r.toLowerCase());
  if (!hit) fail(`${label}: "${r}" isn't a row of "${pages[dbId].title?.trim() || "Untitled"}". Give a row id or its exact title.`);
  return hit.id;
}
const isObjLike = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A value as the app stores it. Options may be named (a new name adds the option, as typing one in the app does);
 * people by id, email or name; related rows by id or title. Returns undefined to clear the value.
 */
export function storedValue(prop: DbProperty, value: unknown, people: Person[], addOption: (name: string) => PropOption, pages: Pages = {}): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  const label = `"${prop.name}" (${PROP_TYPE_LABEL[prop.type]})`;
  switch (prop.type) {
    case "created_time":
    case "last_edited_time":
    case "created_by":
    case "last_edited_by":
    case "unique_id":
    case "formula":
    case "rollup":
      return fail(`${label} is worked out by Sandpiper and can't be set.`);
    case "button":
      return fail(`${label} is a button. Press it with press_button.`);
    case "checkbox": {
      if (typeof value === "boolean") return value || undefined;
      const s = String(value).toLowerCase();
      if (["true", "yes", "1", "checked", "on", "x"].includes(s)) return true;
      if (["false", "no", "0", "unchecked", "off"].includes(s)) return undefined;
      return fail(`${label} takes true or false.`);
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[,$€£¥₹\s%]/g, ""));
      if (!Number.isFinite(n)) fail(`${label} takes a number.`);
      return n;
    }
    case "date": {
      if (isObjLike(value)) {
        const v = value as any;
        const start = dateText(v.start, label);
        const end = v.end ? dateText(v.end, label) : undefined;
        if (end && end.slice(0, 10) < start.slice(0, 10)) fail(`${label}: the end comes before the start.`);
        return storeDate({ start, end });
      }
      const parts = String(value).split(/\s*(?:→|->|\/\/)\s*/);
      if (parts.length === 2) return storedValue(prop, { start: parts[0], end: parts[1] }, people, addOption, pages);
      return dateText(value, label);
    }
    case "select":
    case "status": {
      if (Array.isArray(value)) {
        if (value.length > 1) fail(`${label} holds one option; use a multi-select property for several.`);
        return storedValue(prop, value[0], people, addOption, pages);
      }
      const found = findOption(prop, value);
      if (found) return found.id;
      if (prop.type === "status") fail(`${label} has no option "${value}". Its options: ${(prop.options ?? []).map((o) => o.name).join(", ")}. Add one with update_property.`);
      return addOption(String(value).trim()).id;
    }
    case "multi_select": {
      const list = Array.isArray(value) ? value : String(value).split(",");
      const ids = list
        .map((x) => String(x).trim())
        .filter(Boolean)
        .map((x) => (findOption(prop, x) ?? addOption(x)).id);
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case "person": {
      const list = Array.isArray(value) ? value : [value];
      const ids = list.map((x) => findPerson(people, x, label));
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case "files": {
      const list = Array.isArray(value) ? value : [value];
      const files = list.map((f) => {
        const url = String(isObjLike(f) ? (f as any).url : f).trim();
        if (!/^(https:\/\/|\/uploads\/)/.test(url)) fail(`${label}: files are https:// addresses or uploaded files (/uploads/… from upload_file).`);
        const name = isObjLike(f) && (f as any).name ? String((f as any).name).slice(0, 200) : decodeURIComponent(url.split("/").pop()?.split("?")[0] || url);
        return { name, url };
      });
      return files.length ? files : undefined;
    }
    case "relation": {
      const list = Array.isArray(value) ? value : [value];
      const ids = list.map((x) => findRelated(pages, prop, x, label));
      return ids.length ? [...new Set(ids)] : undefined;
    }
    default: {
      if (typeof value === "object") fail(`${label} takes text.`);
      const s = String(value);
      if (s.length > 20_000) fail(`${label}: that's too long.`);
      return s;
    }
  }
}

const noNewOptions = (): PropOption => fail("A filter can't add options.");

/** One filter written by an AI ({property, op, value}) in the form the app stores (option ids, numbers). */
export function storedFilter(db: Page, raw: any, people: Person[], id: string, c?: DbCtx): DbFilter {
  const prop = propertyOf(db, raw?.property ?? raw?.propId ?? "");
  const ops = opsFor(prop, c, db);
  const op = String(raw?.op ?? raw?.operator ?? "");
  const def = ops.find((o) => o.op === op);
  if (!def) fail(`A filter on "${prop.name}" (${prop.id === "title" ? "title" : PROP_TYPE_LABEL[prop.type]}) can use: ${ops.map((o) => o.op).join(", ") || "no filters"}.`);
  const f: DbFilter = { id, propId: prop.id, op };
  if (def.noValue) return f;
  const v = raw?.value;
  if (v === undefined || v === null || v === "") fail(`The filter "${prop.name} ${op}" needs a value.`);
  const kind = kindOf(prop, c, db);
  if (op === "within") {
    if (!WITHIN.some((w) => w.id === v)) fail(`"is within" takes one of: ${WITHIN.map((w) => w.id).join(", ")}.`);
    f.value = v;
  } else if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    if (prop.type === "status" && /^(group:)?(todo|doing|done|to-do|in progress|complete)$/i.test(String(v)) && !findOption(prop, v)) {
      const g = String(v).toLowerCase().replace("group:", "");
      f.value = "group:" + (g === "to-do" ? "todo" : g === "in progress" ? "doing" : g === "complete" ? "done" : g);
    } else {
      const o = findOption(prop, v);
      if (!o) fail(`"${prop.name}" has no option "${v}". Options: ${(prop.options ?? []).map((x) => x.name).join(", ") || "none yet"}.`);
      f.value = o.id;
    }
  } else if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") f.value = findPerson(people, v, `"${prop.name}"`);
  else if (prop.type === "relation") f.value = findRelated(c?.pages ?? {}, prop, v, `"${prop.name}"`);
  else if (kind === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`The filter on "${prop.name}" takes a number.`);
    f.value = n;
  } else if (kind === "date") {
    if (!RELATIVE_DAYS.some((r) => r.id === v) && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
      fail(`The filter on "${prop.name}" takes a date (YYYY-MM-DD) or one of: ${RELATIVE_DAYS.map((r) => r.id).join(", ")}.`);
    f.value = String(v);
  } else f.value = String(v);
  return f;
}

/**
 * A view's filters as an AI writes them: a list of {property, op, value}, where an item may also be a group
 * {"any_of": [...]} (matches if any of its filters does) or {"all_of": [...]}.
 */
export function storedFilters(db: Page, raw: unknown, people: Person[], nid: () => string, c?: DbCtx): FilterItem[] {
  if (!Array.isArray(raw)) fail('filters is a list like [{"property": "Status", "op": "is", "value": "Done"}].');
  return (raw as any[]).map((item) => {
    const any = item?.any_of ?? item?.or;
    const all = item?.all_of ?? item?.and;
    if (any || all) {
      const list = any ?? all;
      if (!Array.isArray(list) || !list.length) fail("A filter group lists its filters: {\"any_of\": [{…}, {…}]}.");
      const g: DbFilterGroup = { id: nid(), group: any ? "or" : "and", filters: list.map((x: any) => storedFilter(db, x, people, nid(), c)) };
      return g;
    }
    return storedFilter(db, item, people, nid(), c);
  });
}

/** A view's filters as people read them. */
export function readableFilter(db: Page, f: FilterItem, users: Record<string, User>, pages: Pages = {}): unknown {
  if (isGroup(f)) return { [f.group === "or" ? "any_of" : "all_of"]: f.filters.map((x) => readableFilter(db, x, users, pages)) };
  const prop = allProps(db).find((p) => p.id === f.propId);
  let value = f.value;
  if (prop && (prop.type === "select" || prop.type === "multi_select" || prop.type === "status")) value = prop.options?.find((o) => o.id === f.value)?.name ?? f.value;
  if (prop?.type === "person" || prop?.type === "created_by" || prop?.type === "last_edited_by") value = users[f.value]?.name ?? f.value;
  if (prop?.type === "relation") value = pages[f.value]?.title?.trim() || f.value;
  return { property: prop?.name ?? f.propId, op: f.op, ...(value !== undefined ? { value } : {}) };
}

/** A property's settings as an AI reads them. */
export function readableProperty(p: DbProperty, db: Page, pages: Pages, c: DbCtx) {
  const name = (dbId: string | undefined, id: string | undefined) => (id === "title" ? "Name" : (pages[dbId ?? ""]?.properties ?? []).find((x) => x.id === id)?.name);
  const out: Record<string, unknown> = { id: p.id, name: p.name, type: p.type };
  if (p.description) out.description = p.description;
  if (p.options) out.options = p.options.map((o) => ({ name: o.name, color: o.color, ...(p.type === "status" ? { group: o.group ?? "todo" } : {}) }));
  if (p.numberFormat) out.number_format = p.numberFormat;
  if (p.decimals != null) out.decimals = p.decimals;
  if (p.showAs) out.show_as = p.showAs;
  if (p.showAs && p.barColor) out.bar_color = p.barColor;
  if (p.showAs && p.divideBy) out.divide_by = p.divideBy;
  if (p.showNumber === false) out.show_number = false;
  if (p.dateFormat) out.date_format = p.dateFormat;
  if (p.timeFormat) out.time_format = p.timeFormat;
  if (p.relation) out.related_database = { id: p.relation.dbId, title: pages[p.relation.dbId]?.title?.trim() || "Deleted database", two_way: !!p.relation.syncedPropId };
  if (p.rollup) {
    const rel = db.properties?.find((x) => x.id === p.rollup!.relationPropId);
    out.rollup = { relation_property: rel?.name ?? null, rollup_property: name(rel?.relation?.dbId, p.rollup.targetPropId) ?? null, calculate: p.rollup.fn };
  }
  if (p.type === "formula") out.expression = p.formula ?? "";
  if (p.type === "formula" || p.type === "rollup") out.result_type = kindOf(p, c, db);
  if (p.prefix) out.prefix = p.prefix;
  if (p.button) out.button = { label: p.button.label, actions: p.button.actions.map((a) => ({ property: name(db.id, a.propId) ?? a.propId, value: a.value })) };
  return out;
}

