// Databases as plain data: property types and their settings, how values read and show, filters (with and/or
// groups), sorts, grouping, calculations, relations, rollups and formulas. Shared by the app (src/) and the server
// (worker/), so a view shows the same rows in both and an AI sees what people see. Pure: no DOM, no Yjs.
import { evaluate, FDate, FormulaEnv, FormulaError, FValue, formatWith, isDate, isPage, isPerson, parseDateText, toText } from "./formula";

export * from "./formula";

// ---------------------------------------------------------------- types

export type PropType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "person"
  | "files"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "relation"
  | "rollup"
  | "formula"
  | "button"
  | "unique_id"
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by";

/** In the order the "add a property" menu lists them. */
export const PROP_TYPES: PropType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "person",
  "files",
  "checkbox",
  "url",
  "email",
  "phone",
  "relation",
  "rollup",
  "formula",
  "button",
  "unique_id",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
];

export const PROP_TYPE_LABEL: Record<PropType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  multi_select: "Multi-select",
  status: "Status",
  date: "Date",
  person: "Person",
  files: "Files & media",
  checkbox: "Checkbox",
  url: "URL",
  email: "Email",
  phone: "Phone",
  relation: "Relation",
  rollup: "Rollup",
  formula: "Formula",
  button: "Button",
  unique_id: "ID",
  created_time: "Created time",
  created_by: "Created by",
  last_edited_time: "Last edited time",
  last_edited_by: "Last edited by",
};

/** Properties whose values Sandpiper works out itself; nobody types them in. */
export const COMPUTED: PropType[] = ["rollup", "formula", "button", "unique_id", "created_time", "created_by", "last_edited_time", "last_edited_by"];
export const isComputed = (t: PropType) => COMPUTED.includes(t);

export type StatusGroup = "todo" | "doing" | "done";
export const STATUS_GROUPS: { id: StatusGroup; label: string }[] = [
  { id: "todo", label: "To-do" },
  { id: "doing", label: "In progress" },
  { id: "done", label: "Complete" },
];

export interface PropOption {
  id: string;
  name: string;
  color: string;
  /** Status options only: which of To-do, In progress and Complete it belongs to. */
  group?: StatusGroup;
}

/** What a button property does to its row when pressed. */
export interface ButtonAction {
  propId: string;
  /** A value as stored, or one of: { now: true } (dates), { me: true } (people), { toggle: true } (checkboxes), { clear: true }. */
  value: any;
}

export type DateFormat = "default" | "full" | "mdy" | "dmy" | "ymd" | "relative";
export type TimeFormat = "12h" | "24h";

export interface DbProperty {
  id: string;
  name: string;
  type: PropType;
  description?: string;
  options?: PropOption[];
  // number (and formulas/rollups that give numbers)
  numberFormat?: string;
  decimals?: number;
  showAs?: "number" | "bar" | "ring";
  barColor?: string;
  divideBy?: number;
  showNumber?: boolean;
  // dates
  dateFormat?: DateFormat;
  timeFormat?: TimeFormat;
  // relation: which database it points to, and the property on that database that mirrors it (two-way)
  relation?: { dbId: string; syncedPropId?: string };
  // rollup: a relation on this database, a property of the related rows, and how to sum them up
  rollup?: { relationPropId: string; targetPropId: string; fn: string };
  formula?: string;
  // unique ID
  prefix?: string;
  nextId?: number;
  button?: { label?: string; actions: ButtonAction[] };
}

export interface DbFilter {
  id: string;
  propId: string; // "title" for the name column
  op: string;
  value?: any;
}
export interface DbFilterGroup {
  id: string;
  group: "and" | "or";
  filters: DbFilter[];
}
export type FilterItem = DbFilter | DbFilterGroup;
export const isGroup = (f: FilterItem): f is DbFilterGroup => !!(f as DbFilterGroup).group;

export interface DbSort {
  propId: string;
  dir: "asc" | "desc";
}

export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart";
export const VIEW_TYPES: ViewType[] = ["table", "board", "list", "gallery", "calendar", "timeline", "chart"];
export const VIEW_LABEL: Record<ViewType, string> = {
  table: "Table",
  board: "Board",
  list: "List",
  gallery: "Gallery",
  calendar: "Calendar",
  timeline: "Timeline",
  chart: "Chart",
};

export type GroupDate = "relative" | "day" | "week" | "month" | "year";
export type ChartType = "bar" | "hbar" | "line" | "donut";
export interface ChartConfig {
  type: ChartType;
  /** The property the chart groups rows by. */
  x?: string;
  /** count, or an aggregate of a number property. */
  y?: { fn: string; propId?: string };
  /** Split each bar by a second property (stacked). */
  stack?: string;
  sortBy?: "x" | "y";
  showLabels?: boolean;
  hideEmpty?: boolean;
}

export interface DbView {
  id: string;
  name: string;
  type: ViewType;
  filters: FilterItem[];
  /** How the top-level filters combine. */
  filterOp?: "and" | "or";
  sorts: DbSort[];
  groupBy?: string;
  groupDate?: GroupDate;
  hideEmptyGroups?: boolean;
  hiddenGroups?: string[];
  collapsedGroups?: string[];
  colorGroups?: boolean;
  dateProp?: string;
  /** Timeline: where bars end, when the start and end are in separate properties. */
  endProp?: string;
  timelineScale?: "day" | "week" | "month" | "quarter" | "year";
  showTable?: boolean;
  hidden?: string[];
  widths?: Record<string, number>;
  wrap?: boolean;
  wrapCols?: string[];
  /** How many columns from the left stay put while the table scrolls sideways. */
  freeze?: number;
  calcs?: Record<string, string>;
  openIn?: "side" | "center" | "full";
  showIcons?: boolean;
  cardPreview?: string; // "none" | "cover" | files property id
  cardSize?: "small" | "medium" | "large";
  fitImage?: boolean;
  weekStart?: 0 | 1;
  showWeekends?: boolean;
  chart?: ChartConfig;
}

export interface Page {
  id: string;
  title: string;
  icon?: string;
  cover?: string;
  parentId: string | null;
  order: number;
  kind: "page" | "database";
  isRow?: boolean;
  trashed?: boolean;
  trashedAt?: number;
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  updatedBy?: string;
  fullWidth?: boolean;
  smallText?: boolean;
  font?: "default" | "serif" | "mono";
  locked?: boolean;
  template?: string;
  description?: string;
  properties?: DbProperty[];
  views?: DbView[];
  props?: Record<string, any>;
}
export type Pages = Record<string, Page>;

export interface User {
  id: string;
  name: string;
  color: string;
  avatar?: string | null;
}

/** The name column every database has. */
export const TITLE: DbProperty = { id: "title", name: "Name", type: "text" };

export const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

// ---------------------------------------------------------------- context

/** Everything a value may need: other rows (relations, rollups), people, and the time formulas see as now(). */
export interface DbCtx {
  pages: Pages;
  users: Record<string, User>;
  now: number;
  email?: (userId: string) => string;
  /** Filled in while working: computed values, and formulas being worked out (to catch loops). */
  cache?: Map<string, any>;
  busy?: Set<string>;
}
export function dbCtx(pages: Pages, users: Record<string, User>, extra: Partial<DbCtx> = {}): DbCtx {
  return { pages, users, now: Date.now(), cache: new Map(), busy: new Set(), ...extra };
}
const cacheOf = (c: DbCtx) => (c.cache ??= new Map());

// ---------------------------------------------------------------- tree helpers

export function sortPages(list: Page[]): Page[] {
  return list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}
export function rowsOf(pages: Pages, dbId: string): Page[] {
  return sortPages(Object.values(pages).filter((p) => p.parentId === dbId && p.isRow && !p.trashed));
}
export function dbOf(pages: Pages, row: Page): Page | undefined {
  const db = row.parentId ? pages[row.parentId] : undefined;
  return db?.kind === "database" ? db : undefined;
}
export function allProps(db: Page | undefined): DbProperty[] {
  return [TITLE, ...(db?.properties ?? [])];
}
export function propByName(db: Page | undefined, name: string): DbProperty | undefined {
  const n = name.trim().toLowerCase();
  return allProps(db).find((p) => p.name.toLowerCase() === n) ?? (n === "title" || n === "name" ? TITLE : undefined);
}
const alive = (pages: Pages, id: string) => {
  const p = pages[id];
  return !!p && !p.trashed;
};

// ---------------------------------------------------------------- stored values

export const asArray = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" && v ? [v] : []);

export interface DateVal {
  start: string; // YYYY-MM-DD or YYYY-MM-DDTHH:mm
  end?: string;
}
/** A date property's value, whether stored as text ("2026-11-14", "2026-11-14T09:30") or as { start, end }. */
export function dateVal(v: any): DateVal | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return { start: v };
  if (v && typeof v === "object" && typeof v.start === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.start)) {
    return typeof v.end === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.end) && v.end !== v.start ? { start: v.start, end: v.end } : { start: v.start };
  }
  return null;
}
/** The stored form of a date value: plain text without an end, { start, end } with one. */
export function storeDate(d: DateVal | null): any {
  if (!d) return undefined;
  return d.end && d.end !== d.start ? { start: d.start, end: d.end } : d.start;
}
export const hasTime = (s: string) => /T\d{2}:\d{2}/.test(s);
/** A day (YYYY-MM-DD, times kept) moved by a number of days. */
export function shiftDay(s: string, days: number): string {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return ymd(new Date(y, m - 1, d + days)) + s.slice(10);
}
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.slice(0, 10).split("-").map(Number);
  const [y2, m2, d2] = b.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}
/** A date (or range) moved so it starts on another day, keeping its length and times. */
export function moveDate(d: DateVal, toDay: string): DateVal {
  const n = daysBetween(d.start, toDay);
  return { start: shiftDay(d.start, n), end: d.end ? shiftDay(d.end, n) : undefined };
}
export function ymd(d: Date | number): string {
  const x = typeof d === "number" ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
function toFDate(d: DateVal): FDate | null {
  const a = parseDateText(d.start);
  if (!a) return null;
  const b = d.end ? parseDateText(d.end) : null;
  return { kind: "date", start: a.start, end: b ? b.start : undefined, time: hasTime(d.start) };
}

export interface FileVal {
  name: string;
  url: string;
}
export function filesVal(v: any): FileVal[] {
  return Array.isArray(v) ? v.filter((f) => f && typeof f.url === "string").map((f) => ({ name: String(f.name ?? f.url), url: f.url })) : [];
}

/** Related row ids that still exist. */
export function relationIds(row: Page, prop: DbProperty, c: DbCtx): string[] {
  return asArray(row.props?.[prop.id]).filter((id) => alive(c.pages, id));
}

/** A unique ID property's number for a row: stored when the row was made, else its place among the rows by age. */
export function uniqueId(row: Page, prop: DbProperty, c: DbCtx): number {
  const stored = row.props?.[prop.id];
  if (typeof stored === "number") return stored;
  const key = "uid:" + row.parentId + ":" + prop.id;
  let ranks: Map<string, number> = cacheOf(c).get(key);
  if (!ranks) {
    ranks = new Map();
    const all = Object.values(c.pages)
      .filter((p) => p.parentId === row.parentId && p.isRow)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let n = 0;
    for (const p of all) {
      const s = p.props?.[prop.id];
      n = typeof s === "number" ? Math.max(n, s) : n + 1;
      ranks.set(p.id, typeof s === "number" ? s : n);
    }
    cacheOf(c).set(key, ranks);
  }
  return ranks.get(row.id) ?? 0;
}

// ---------------------------------------------------------------- values as formulas see them

/** A row's value for a property, as a formula value (option names, people, pages, dates). */
export function fvalue(row: Page, prop: DbProperty, c: DbCtx): FValue {
  if (prop.id === "title") return row.title ?? "";
  const v = row.props?.[prop.id];
  switch (prop.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
      return v == null ? "" : String(v);
    case "number":
      return typeof v === "number" ? v : v == null || v === "" ? null : Number(v);
    case "checkbox":
      return !!v;
    case "select":
    case "status":
      return prop.options?.find((o) => o.id === v)?.name ?? "";
    case "multi_select":
      return asArray(v)
        .map((id) => prop.options?.find((o) => o.id === id)?.name)
        .filter((x): x is string => !!x);
    case "date": {
      const d = dateVal(v);
      return d ? toFDate(d) : null;
    }
    case "person":
      return asArray(v).map((id) => ({ kind: "person" as const, id }));
    case "created_by":
      return row.createdBy ? { kind: "person", id: row.createdBy } : null;
    case "last_edited_by":
      return row.updatedBy ? { kind: "person", id: row.updatedBy } : null;
    case "files":
      return filesVal(v).map((f) => f.name || f.url);
    case "relation":
      return relationIds(row, prop, c).map((id) => ({ kind: "page" as const, id }));
    case "created_time":
      return { kind: "date", start: row.createdAt, time: true };
    case "last_edited_time":
      return { kind: "date", start: row.updatedAt, time: true };
    case "unique_id": {
      const n = uniqueId(row, prop, c);
      return prop.prefix ? `${prop.prefix}-${n}` : n;
    }
    case "rollup":
      return rollupValue(row, prop, c);
    case "formula":
      return formulaValue(row, prop, c).value;
    case "button":
      return null;
  }
}

function envFor(c: DbCtx): FormulaEnv {
  return {
    now: c.now,
    prop: (rowId, name) => {
      const row = c.pages[rowId];
      if (!row) return null;
      const p = propByName(dbOf(c.pages, row), name);
      return p ? fvalue(row, p, c) : undefined;
    },
    title: (rowId) => c.pages[rowId]?.title?.trim() || "Untitled",
    person: (id) => ({ name: c.users[id]?.name ?? "Someone", email: c.email?.(id) ?? "" }),
  };
}

/** A formula property's result for a row, or the reason it couldn't be worked out. */
export function formulaValue(row: Page, prop: DbProperty, c: DbCtx): { value: FValue; error?: string } {
  const key = "f:" + row.id + ":" + prop.id;
  const cache = cacheOf(c);
  if (cache.has(key)) return cache.get(key);
  const busy = (c.busy ??= new Set());
  if (busy.has(key)) throw new FormulaError(`"${prop.name}" refers back to itself.`);
  busy.add(key);
  let out: { value: FValue; error?: string };
  try {
    out = { value: evaluate(prop.formula ?? "", row.id, envFor(c)) };
  } catch (e) {
    if (e instanceof FormulaError && busy.size > 1) {
      busy.delete(key);
      throw e;
    }
    out = { value: null, error: e instanceof FormulaError ? e.message : "This formula couldn't be worked out." };
  }
  busy.delete(key);
  cache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- aggregates (rollups and calculations)

export interface AggDef {
  fn: string;
  label: string;
  /** Which kinds of values it makes sense for. */
  for: "any" | "number" | "date" | "checkbox";
  percent?: boolean;
}
export const AGGREGATES: AggDef[] = [
  { fn: "count_all", label: "Count all", for: "any" },
  { fn: "count_values", label: "Count values", for: "any" },
  { fn: "count_unique", label: "Count unique values", for: "any" },
  { fn: "count_empty", label: "Count empty", for: "any" },
  { fn: "count_not_empty", label: "Count not empty", for: "any" },
  { fn: "percent_empty", label: "Percent empty", for: "any", percent: true },
  { fn: "percent_not_empty", label: "Percent not empty", for: "any", percent: true },
  { fn: "sum", label: "Sum", for: "number" },
  { fn: "average", label: "Average", for: "number" },
  { fn: "median", label: "Median", for: "number" },
  { fn: "min", label: "Min", for: "number" },
  { fn: "max", label: "Max", for: "number" },
  { fn: "range", label: "Range", for: "number" },
  { fn: "earliest", label: "Earliest date", for: "date" },
  { fn: "latest", label: "Latest date", for: "date" },
  { fn: "date_range", label: "Date range", for: "date" },
  { fn: "checked", label: "Checked", for: "checkbox" },
  { fn: "unchecked", label: "Unchecked", for: "checkbox" },
  { fn: "percent_checked", label: "Percent checked", for: "checkbox", percent: true },
  { fn: "percent_unchecked", label: "Percent unchecked", for: "checkbox", percent: true },
];
export const ROLLUP_FNS = [{ fn: "show_original", label: "Show original", for: "any" as const }, { fn: "show_unique", label: "Show unique values", for: "any" as const }, ...AGGREGATES];

const emptyF = (v: FValue): boolean => v == null || v === "" || (Array.isArray(v) && v.every(emptyF));
const flat = (vs: FValue[]): FValue[] => vs.flatMap((v) => (Array.isArray(v) ? flat(v) : [v]));
const keyOf = (v: FValue): string => (isDate(v) ? "d" + v.start : isPage(v) || isPerson(v) ? "r" + v.id : JSON.stringify(v));

/** Sums up one value per row (each may itself be a list) the way a rollup or a column calculation does. */
export function aggregate(fn: string, perRow: FValue[]): FValue {
  const values = flat(perRow).filter((v) => !emptyF(v));
  const nums = values.map((v) => (typeof v === "number" ? v : typeof v === "boolean" ? NaN : Number(v))).filter((n) => Number.isFinite(n));
  const dates = values.filter(isDate);
  const empties = perRow.filter((v) => emptyF(v) || v === false).length;
  const total = perRow.length;
  const pct = (n: number) => (total ? n / total : 0);
  switch (fn) {
    case "show_original":
      return values;
    case "show_unique":
      return values.filter((v, i, a) => a.findIndex((x) => keyOf(x) === keyOf(v)) === i);
    case "count_all":
      return total;
    case "count_values":
      return values.length;
    case "count_unique":
      return new Set(values.map(keyOf)).size;
    case "count_empty":
      return empties;
    case "count_not_empty":
      return total - empties;
    case "percent_empty":
      return pct(empties);
    case "percent_not_empty":
      return pct(total - empties);
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "average":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case "median": {
      if (!nums.length) return null;
      const s = [...nums].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case "earliest": {
      if (!dates.length) return null;
      return dates.reduce((a, b) => (b.start < a.start ? b : a));
    }
    case "latest": {
      if (!dates.length) return null;
      return dates.reduce((a, b) => ((b.end ?? b.start) > (a.end ?? a.start) ? b : a));
    }
    case "date_range": {
      if (!dates.length) return null;
      const lo = Math.min(...dates.map((d) => d.start));
      const hi = Math.max(...dates.map((d) => d.end ?? d.start));
      return Math.round((hi - lo) / 86_400_000);
    }
    case "checked":
      return perRow.filter((v) => v === true).length;
    case "unchecked":
      return perRow.filter((v) => v !== true).length;
    case "percent_checked":
      return pct(perRow.filter((v) => v === true).length);
    case "percent_unchecked":
      return pct(perRow.filter((v) => v !== true).length);
    default:
      return null;
  }
}
export const isPercentAgg = (fn: string) => !!AGGREGATES.find((a) => a.fn === fn)?.percent;

/** The rollup's relation and target property, if both still exist. */
export function rollupParts(db: Page | undefined, prop: DbProperty, pages: Pages): { relation: DbProperty; target: DbProperty; targetDb: Page } | null {
  const cfg = prop.rollup;
  if (!cfg) return null;
  const relation = db?.properties?.find((p) => p.id === cfg.relationPropId && p.type === "relation");
  const targetDb = relation?.relation ? pages[relation.relation.dbId] : undefined;
  if (!relation || !targetDb) return null;
  const target = allProps(targetDb).find((p) => p.id === cfg.targetPropId);
  return target ? { relation, target, targetDb } : null;
}

export function rollupValue(row: Page, prop: DbProperty, c: DbCtx): FValue {
  const parts = rollupParts(dbOf(c.pages, row), prop, c.pages);
  if (!parts) return null;
  const key = "r:" + row.id + ":" + prop.id;
  const cache = cacheOf(c);
  if (cache.has(key)) return cache.get(key);
  const busy = (c.busy ??= new Set());
  if (busy.has(key)) return null;
  busy.add(key);
  const related = relationIds(row, parts.relation, c).map((id) => c.pages[id]);
  const value = aggregate(prop.rollup!.fn || "show_original", related.map((r) => fvalue(r, parts.target, c)));
  busy.delete(key);
  cache.set(key, value);
  return value;
}

// ---------------------------------------------------------------- kinds

/** How a property's values behave for filters, sorting and calculations. */
export type Kind = "text" | "number" | "select" | "multi" | "date" | "checkbox" | "person" | "relation" | "files" | "none";

/** A computed value's kind, from what it holds. */
function kindOfF(v: FValue): Kind {
  if (Array.isArray(v)) {
    const first = v.find((x) => !emptyF(x));
    if (first === undefined) return "multi";
    return isPage(first) ? "relation" : isPerson(first) ? "person" : isDate(first) ? "date" : typeof first === "number" ? "number" : "multi";
  }
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  if (isDate(v)) return "date";
  if (isPerson(v)) return "person";
  return "text";
}

export function kindOf(prop: DbProperty, c?: DbCtx, db?: Page): Kind {
  switch (prop.type) {
    case "number":
    case "unique_id":
      return prop.type === "unique_id" && prop.prefix ? "text" : "number";
    case "select":
    case "status":
      return "select";
    case "multi_select":
      return "multi";
    case "date":
    case "created_time":
    case "last_edited_time":
      return "date";
    case "checkbox":
      return "checkbox";
    case "person":
    case "created_by":
    case "last_edited_by":
      return "person";
    case "relation":
      return "relation";
    case "files":
      return "files";
    case "button":
      return "none";
    case "formula":
    case "rollup": {
      if (!c || !db) return "text";
      const key = "k:" + db.id + ":" + prop.id;
      const cache = cacheOf(c);
      if (cache.has(key)) return cache.get(key);
      let kind: Kind = prop.type === "rollup" && ["count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty", "sum", "average", "median", "min", "max", "range", "checked", "unchecked", "percent_checked", "percent_unchecked", "date_range"].includes(prop.rollup?.fn ?? "") ? "number" : "text";
      if (kind === "text") {
        for (const r of rowsOf(c.pages, db.id)) {
          let v: FValue = null;
          try {
            v = fvalue(r, prop, c);
          } catch {
            /* a broken formula reads as nothing */
          }
          if (!emptyF(v) || typeof v === "boolean") {
            kind = kindOfF(v);
            break;
          }
        }
      }
      cache.set(key, kind);
      return kind;
    }
    default:
      return "text";
  }
}

// ---------------------------------------------------------------- showing values

export interface NumberFormat {
  id: string;
  label: string;
  currency?: string;
}
const CURRENCIES: [string, string][] = [
  ["USD", "US dollar"],
  ["AUD", "Australian dollar"],
  ["CAD", "Canadian dollar"],
  ["SGD", "Singapore dollar"],
  ["EUR", "Euro"],
  ["GBP", "Pound"],
  ["JPY", "Yen"],
  ["RUB", "Ruble"],
  ["INR", "Rupee"],
  ["KRW", "Won"],
  ["CNY", "Yuan"],
  ["BRL", "Real"],
  ["TRY", "Lira"],
  ["IDR", "Rupiah"],
  ["CHF", "Franc"],
  ["HKD", "Hong Kong dollar"],
  ["NZD", "New Zealand dollar"],
  ["SEK", "Swedish krona"],
  ["NOK", "Norwegian krone"],
  ["MXN", "Mexican peso"],
  ["ZAR", "Rand"],
  ["TWD", "New Taiwan dollar"],
  ["DKK", "Danish krone"],
  ["PLN", "Złoty"],
  ["THB", "Baht"],
  ["HUF", "Forint"],
  ["CZK", "Koruna"],
  ["ILS", "Shekel"],
  ["CLP", "Chilean peso"],
  ["PHP", "Philippine peso"],
  ["AED", "Dirham"],
  ["COP", "Colombian peso"],
  ["SAR", "Riyal"],
  ["MYR", "Ringgit"],
  ["RON", "Leu"],
  ["ARS", "Argentine peso"],
  ["UAH", "Hryvnia"],
  ["NGN", "Naira"],
  ["VND", "Dong"],
  ["PKR", "Pakistani rupee"],
  ["BDT", "Taka"],
  ["LKR", "Sri Lankan rupee"],
  ["EGP", "Egyptian pound"],
  ["KES", "Kenyan shilling"],
  ["QAR", "Qatari riyal"],
  ["KWD", "Kuwaiti dinar"],
];
export const NUMBER_FORMATS: NumberFormat[] = [
  { id: "number", label: "Number" },
  { id: "comma", label: "Number with separators" },
  { id: "percent", label: "Percent" },
  ...CURRENCIES.map(([code, name]) => ({ id: code, label: `${name} (${code})`, currency: code })),
];

/** A number as its property shows it: separators, percent, currency, decimal places. */
export function formatNumber(n: number, prop?: Pick<DbProperty, "numberFormat" | "decimals">): string {
  if (!Number.isFinite(n)) return String(n);
  const f = prop?.numberFormat ?? "number";
  const d = prop?.decimals;
  const fixed = d == null ? {} : { minimumFractionDigits: d, maximumFractionDigits: d };
  try {
    if (f === "percent") return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2, ...fixed }).format(n);
    const cur = NUMBER_FORMATS.find((x) => x.id === f)?.currency;
    if (cur) return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, currencyDisplay: "narrowSymbol", ...fixed }).format(n);
    return new Intl.NumberFormat("en-US", { useGrouping: f === "comma", maximumFractionDigits: 8, ...fixed }).format(n);
  } catch {
    return String(n);
  }
}
/** How full a number's bar or ring is, 0 to 1. */
export function numberFill(n: number, prop: DbProperty): number {
  const max = prop.divideBy ?? (prop.numberFormat === "percent" ? 1 : 100);
  if (!max) return 0;
  return Math.max(0, Math.min(1, n / max));
}

export const DATE_FORMATS: { id: DateFormat; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "full", label: "Full date" },
  { id: "mdy", label: "Month/Day/Year" },
  { id: "dmy", label: "Day/Month/Year" },
  { id: "ymd", label: "Year/Month/Day" },
  { id: "relative", label: "Relative" },
];
const DATE_PATTERN: Record<DateFormat, string> = {
  default: "MMM D, YYYY",
  full: "MMMM D, YYYY",
  mdy: "MM/DD/YYYY",
  dmy: "DD/MM/YYYY",
  ymd: "YYYY/MM/DD",
  relative: "MMM D, YYYY",
};
function relativeDay(ms: number, now: number): string | null {
  const day = (x: number) => {
    const d = new Date(x);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(ms) - day(now)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return formatWith(ms, "dddd");
  if (diff < -1 && diff > -7) return "Last " + formatWith(ms, "dddd");
  return null;
}
/** A date (or range) as its property shows it. */
export function formatDate(d: FDate, prop?: Pick<DbProperty, "dateFormat" | "timeFormat">, now = Date.now()): string {
  const f = prop?.dateFormat ?? "default";
  const time = prop?.timeFormat === "24h" ? "HH:mm" : "h:mm A";
  const one = (ms: number) => {
    const day = (f === "relative" && relativeDay(ms, now)) || formatWith(ms, DATE_PATTERN[f]);
    return d.time ? `${day} ${formatWith(ms, time)}` : day;
  };
  return d.end != null && d.end !== d.start ? `${one(d.start)} → ${one(d.end)}` : one(d.start);
}

/** A computed (formula or rollup) value as text, with the property's number and date settings. */
export function showF(v: FValue, prop: DbProperty, c: DbCtx, percent = false): string {
  if (v == null) return "";
  if (typeof v === "number") return percent ? formatNumber(v, { numberFormat: "percent", decimals: prop.decimals }) : formatNumber(v, prop);
  if (isDate(v)) return formatDate(v, prop, c.now);
  if (Array.isArray(v)) return v.map((x) => showF(x, prop, c)).filter(Boolean).join(", ");
  if (isPage(v)) return c.pages[v.id]?.title?.trim() || "Untitled";
  if (isPerson(v)) return c.users[v.id]?.name ?? "Someone";
  return toText(v);
}

/** A row's value as plain text: for search, text filters, sorting text, and reading out loud to an AI. */
export function textValue(row: Page, prop: DbProperty, c: DbCtx): string {
  if (prop.id === "title") return row.title ?? "";
  const v = row.props?.[prop.id];
  switch (prop.type) {
    case "select":
    case "status":
    case "multi_select":
      return asArray(v)
        .map((id) => prop.options?.find((o) => o.id === id)?.name ?? "")
        .filter(Boolean)
        .join(", ");
    case "person":
      return asArray(v)
        .map((id) => c.users[id]?.name ?? "")
        .filter(Boolean)
        .join(", ");
    case "created_by":
      return row.createdBy ? (c.users[row.createdBy]?.name ?? "") : "";
    case "last_edited_by":
      return row.updatedBy ? (c.users[row.updatedBy]?.name ?? "") : "";
    case "checkbox":
      return v ? "true" : "";
    case "number":
      return typeof v === "number" ? formatNumber(v, prop) : "";
    case "date": {
      const d = dateVal(v);
      const f = d && toFDate(d);
      return f ? formatDate(f, prop, c.now) : "";
    }
    case "created_time":
      return formatDate({ kind: "date", start: row.createdAt, time: true }, prop, c.now);
    case "last_edited_time":
      return formatDate({ kind: "date", start: row.updatedAt, time: true }, prop, c.now);
    case "files":
      return filesVal(v)
        .map((f) => f.name)
        .join(", ");
    case "relation":
      return relationIds(row, prop, c)
        .map((id) => c.pages[id]?.title?.trim() || "Untitled")
        .join(", ");
    case "unique_id": {
      const n = uniqueId(row, prop, c);
      return prop.prefix ? `${prop.prefix}-${n}` : String(n);
    }
    case "rollup":
      return showF(rollupValue(row, prop, c), prop, c, isPercentAgg(prop.rollup?.fn ?? ""));
    case "formula": {
      const r = formulaValue(row, prop, c);
      return r.error ? "" : showF(r.value, prop, c);
    }
    case "button":
      return "";
    default:
      return v == null ? "" : String(v);
  }
}

export function isEmptyValue(row: Page, prop: DbProperty, c: DbCtx): boolean {
  if (prop.id === "title") return !row.title?.trim();
  switch (prop.type) {
    case "created_time":
    case "last_edited_time":
    case "unique_id":
      return false;
    case "created_by":
      return !row.createdBy;
    case "last_edited_by":
      return !row.updatedBy;
    case "checkbox":
      return !row.props?.[prop.id];
    case "relation":
      return relationIds(row, prop, c).length === 0;
    case "files":
      return filesVal(row.props?.[prop.id]).length === 0;
    case "date":
      return !dateVal(row.props?.[prop.id]);
    case "rollup":
    case "formula": {
      let v: FValue = null;
      try {
        v = fvalue(row, prop, c);
      } catch {
        return true;
      }
      return emptyF(v) || v === false;
    }
    case "button":
      return true;
    default: {
      const v = row.props?.[prop.id];
      return v == null || v === "" || (Array.isArray(v) && v.length === 0);
    }
  }
}

// ---------------------------------------------------------------- filters

export interface OpDef {
  op: string;
  label: string;
  noValue?: boolean;
}
const EMPTY_OPS: OpDef[] = [
  { op: "empty", label: "Is empty", noValue: true },
  { op: "not_empty", label: "Is not empty", noValue: true },
];
export function opsForKind(kind: Kind): OpDef[] {
  switch (kind) {
    case "number":
      return [
        { op: "eq", label: "=" },
        { op: "neq", label: "≠" },
        { op: "gt", label: ">" },
        { op: "lt", label: "<" },
        { op: "gte", label: "≥" },
        { op: "lte", label: "≤" },
        ...EMPTY_OPS,
      ];
    case "select":
      return [{ op: "is", label: "Is" }, { op: "is_not", label: "Is not" }, ...EMPTY_OPS];
    case "multi":
    case "person":
    case "relation":
      return [{ op: "contains", label: "Contains" }, { op: "not_contains", label: "Does not contain" }, ...EMPTY_OPS];
    case "files":
      return EMPTY_OPS;
    case "checkbox":
      return [
        { op: "checked", label: "Is checked", noValue: true },
        { op: "unchecked", label: "Is not checked", noValue: true },
      ];
    case "date":
      return [
        { op: "is", label: "Is" },
        { op: "before", label: "Is before" },
        { op: "after", label: "Is after" },
        { op: "on_or_before", label: "Is on or before" },
        { op: "on_or_after", label: "Is on or after" },
        { op: "within", label: "Is within" },
        ...EMPTY_OPS,
      ];
    case "none":
      return [];
    default:
      return [
        { op: "contains", label: "Contains" },
        { op: "not_contains", label: "Does not contain" },
        { op: "is", label: "Is" },
        { op: "is_not", label: "Is not" },
        { op: "starts_with", label: "Starts with" },
        { op: "ends_with", label: "Ends with" },
        ...EMPTY_OPS,
      ];
  }
}
export function opsFor(prop: DbProperty, c?: DbCtx, db?: Page): OpDef[] {
  return opsForKind(kindOf(prop, c, db));
}

/** Dates a filter can be relative to, so "is after: today" stays true to its word tomorrow. */
export const RELATIVE_DAYS: { id: string; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "yesterday", label: "Yesterday" },
  { id: "one_week_ago", label: "One week ago" },
  { id: "one_week_from_now", label: "One week from now" },
  { id: "one_month_ago", label: "One month ago" },
  { id: "one_month_from_now", label: "One month from now" },
];
export const WITHIN: { id: string; label: string }[] = [
  { id: "this_week", label: "This week" },
  { id: "past_week", label: "The past week" },
  { id: "next_week", label: "The next week" },
  { id: "this_month", label: "This month" },
  { id: "past_month", label: "The past month" },
  { id: "next_month", label: "The next month" },
  { id: "this_year", label: "This year" },
  { id: "past_year", label: "The past year" },
  { id: "next_year", label: "The next year" },
];
function dayOffset(now: number, days: number, months = 0): string {
  const d = new Date(now);
  return ymd(new Date(d.getFullYear(), d.getMonth() + months, d.getDate() + days));
}
/** A filter's date: YYYY-MM-DD as written, or a relative one worked out against now. */
export function resolveDay(v: string, now: number): string {
  switch (v) {
    case "today":
      return dayOffset(now, 0);
    case "tomorrow":
      return dayOffset(now, 1);
    case "yesterday":
      return dayOffset(now, -1);
    case "one_week_ago":
      return dayOffset(now, -7);
    case "one_week_from_now":
      return dayOffset(now, 7);
    case "one_month_ago":
      return dayOffset(now, 0, -1);
    case "one_month_from_now":
      return dayOffset(now, 0, 1);
    default:
      return String(v).slice(0, 10);
  }
}
/** The first and last day of a "within" period. */
export function withinRange(v: string, now: number): [string, string] {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  switch (v) {
    case "this_week": {
      const s = new Date(y, m, d.getDate() - d.getDay());
      return [ymd(s), ymd(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6))];
    }
    case "past_week":
      return [dayOffset(now, -7), dayOffset(now, 0)];
    case "next_week":
      return [dayOffset(now, 0), dayOffset(now, 7)];
    case "this_month":
      return [ymd(new Date(y, m, 1)), ymd(new Date(y, m + 1, 0))];
    case "past_month":
      return [dayOffset(now, 0, -1), dayOffset(now, 0)];
    case "next_month":
      return [dayOffset(now, 0), dayOffset(now, 0, 1)];
    case "this_year":
      return [`${y}-01-01`, `${y}-12-31`];
    case "past_year":
      return [ymd(new Date(y - 1, m, d.getDate())), dayOffset(now, 0)];
    case "next_year":
      return [dayOffset(now, 0), ymd(new Date(y + 1, m, d.getDate()))];
    default:
      return ["0000-00-00", "9999-12-31"];
  }
}

/** A row's dates as [first day, last day] (YYYY-MM-DD), or null. */
function dayRange(row: Page, prop: DbProperty, c: DbCtx): [string, string] | null {
  let f: FDate | null = null;
  if (prop.type === "date") {
    const d = dateVal(row.props?.[prop.id]);
    f = d ? toFDate(d) : null;
  } else {
    let v: FValue = null;
    try {
      v = fvalue(row, prop, c);
    } catch {
      v = null;
    }
    if (Array.isArray(v)) v = v.find(isDate) ?? null;
    f = isDate(v) ? v : null;
  }
  if (!f) return null;
  return [ymd(f.start), ymd(f.end ?? f.start)];
}

/** Ids a list-like property holds on a row (options, people, pages). */
function idsOn(row: Page, prop: DbProperty, c: DbCtx): string[] {
  switch (prop.type) {
    case "created_by":
      return row.createdBy ? [row.createdBy] : [];
    case "last_edited_by":
      return row.updatedBy ? [row.updatedBy] : [];
    case "relation":
      return relationIds(row, prop, c);
    case "rollup":
    case "formula": {
      let v: FValue = null;
      try {
        v = fvalue(row, prop, c);
      } catch {
        return [];
      }
      return (Array.isArray(v) ? v : [v]).map((x) => (isPage(x) || isPerson(x) ? x.id : toText(x as FValue))).filter(Boolean);
    }
    default:
      return asArray(row.props?.[prop.id]);
  }
}
function numberOn(row: Page, prop: DbProperty, c: DbCtx): number | null {
  if (prop.type === "number") {
    const v = row.props?.[prop.id];
    return typeof v === "number" ? v : v == null || v === "" ? null : Number(v);
  }
  if (prop.type === "unique_id") return uniqueId(row, prop, c);
  let v: FValue = null;
  try {
    v = fvalue(row, prop, c);
  } catch {
    return null;
  }
  return typeof v === "number" ? v : null;
}

export function matches(row: Page, f: DbFilter, prop: DbProperty, c: DbCtx, db?: Page): boolean {
  const kind = kindOf(prop, c, db);
  if (!opsForKind(kind).some((o) => o.op === f.op)) return true;
  if (f.op === "empty") return isEmptyValue(row, prop, c);
  if (f.op === "not_empty") return !isEmptyValue(row, prop, c);
  if (f.op === "checked" || f.op === "unchecked") {
    let on: boolean;
    if (prop.type === "checkbox") on = !!row.props?.[prop.id];
    else {
      try {
        on = fvalue(row, prop, c) === true;
      } catch {
        on = false;
      }
    }
    return f.op === "checked" ? on : !on;
  }
  // A filter with no value yet doesn't hide anything.
  if (f.value == null || f.value === "") return true;
  switch (kind) {
    case "number": {
      const a = numberOn(row, prop, c);
      const b = Number(f.value);
      if (a == null || Number.isNaN(a) || Number.isNaN(b)) return f.op === "neq";
      return ({ eq: a === b, neq: a !== b, gt: a > b, lt: a < b, gte: a >= b, lte: a <= b } as Record<string, boolean>)[f.op] ?? true;
    }
    case "select": {
      const v = prop.type === "select" || prop.type === "status" ? row.props?.[prop.id] : textValue(row, prop, c);
      // A status filter may name a whole group: "group:done".
      if (prop.type === "status" && String(f.value).startsWith("group:")) {
        const g = prop.options?.find((o) => o.id === v)?.group;
        const hit = g === String(f.value).slice(6);
        return f.op === "is" ? hit : !hit;
      }
      return f.op === "is" ? v === f.value : v !== f.value;
    }
    case "multi":
    case "person":
    case "relation": {
      const want = String(f.value).toLowerCase();
      const has = idsOn(row, prop, c).some((x) => x === f.value || x.toLowerCase() === want);
      return f.op === "contains" ? has : !has;
    }
    case "date": {
      const r = dayRange(row, prop, c);
      if (!r) return false;
      if (f.op === "within") {
        const [lo, hi] = withinRange(String(f.value), c.now);
        return r[0] <= hi && r[1] >= lo;
      }
      const day = resolveDay(String(f.value), c.now);
      switch (f.op) {
        case "is":
          return r[0] <= day && day <= r[1];
        case "before":
          return r[0] < day;
        case "after":
          return r[1] > day;
        case "on_or_before":
          return r[0] <= day;
        case "on_or_after":
          return r[1] >= day;
      }
      return true;
    }
    default: {
      const a = textValue(row, prop, c).toLowerCase();
      const b = String(f.value).toLowerCase();
      switch (f.op) {
        case "contains":
          return a.includes(b);
        case "not_contains":
          return !a.includes(b);
        case "is":
          return a === b;
        case "is_not":
          return a !== b;
        case "starts_with":
          return a.startsWith(b);
        case "ends_with":
          return a.endsWith(b);
      }
      return true;
    }
  }
}

/** Whether a row passes a view's filters, groups and and/or included. */
export function passes(row: Page, filters: FilterItem[], op: "and" | "or" | undefined, db: Page, c: DbCtx): boolean {
  const all = allProps(db);
  const one = (f: DbFilter): boolean | null => {
    const prop = all.find((p) => p.id === f.propId);
    return prop ? matches(row, f, prop, c, db) : null;
  };
  const results: boolean[] = [];
  for (const f of filters) {
    if (isGroup(f)) {
      const inner = f.filters.map(one).filter((x): x is boolean => x !== null);
      if (!inner.length) continue;
      results.push(f.group === "or" ? inner.some(Boolean) : inner.every(Boolean));
    } else {
      const r = one(f);
      if (r !== null) results.push(r);
    }
  }
  if (!results.length) return true;
  return op === "or" ? results.some(Boolean) : results.every(Boolean);
}

/** Number of single filters, counting the ones inside groups. */
export function filterCount(filters: FilterItem[]): number {
  return filters.reduce((n, f) => n + (isGroup(f) ? f.filters.length : 1), 0);
}

// ---------------------------------------------------------------- sorting

function sortKey(row: Page, prop: DbProperty, c: DbCtx, db?: Page): number | string | null {
  if (prop.id === "title") return row.title?.trim() || null;
  switch (prop.type) {
    case "number":
    case "unique_id":
      return numberOn(row, prop, c);
    case "checkbox":
      return row.props?.[prop.id] ? 1 : 0;
    case "select":
    case "status": {
      const opts = prop.options ?? [];
      const v = row.props?.[prop.id];
      const i = opts.findIndex((o) => o.id === v);
      if (i < 0) return null;
      if (prop.type === "status") return STATUS_GROUPS.findIndex((g) => g.id === (opts[i].group ?? "todo")) * 1000 + i;
      return i;
    }
    case "date": {
      const d = dateVal(row.props?.[prop.id]);
      const f = d && toFDate(d);
      return f ? f.start : null;
    }
    case "created_time":
      return row.createdAt;
    case "last_edited_time":
      return row.updatedAt;
    case "formula":
    case "rollup": {
      const kind = kindOf(prop, c, db);
      let v: FValue = null;
      try {
        v = fvalue(row, prop, c);
      } catch {
        return null;
      }
      if (kind === "number" && typeof v === "number") return v;
      if (kind === "date" && isDate(v)) return v.start;
      if (kind === "checkbox") return v === true ? 1 : 0;
      const t = textValue(row, prop, c);
      return t || null;
    }
    default: {
      const t = textValue(row, prop, c);
      return t || null;
    }
  }
}

export function compare(a: Page, b: Page, prop: DbProperty, c: DbCtx, db?: Page): number {
  const ka = sortKey(a, prop, c, db);
  const kb = sortKey(b, prop, c, db);
  if (ka == null || kb == null) return ka == null && kb == null ? 0 : ka == null ? 1 : -1; // empties last
  if (typeof ka === "number" && typeof kb === "number") return ka - kb;
  return String(ka).localeCompare(String(kb), undefined, { numeric: true, sensitivity: "base" });
}

/** The rows a view shows, filtered and in order, optionally narrowed by a search. */
export function viewRows(db: Page, view: Pick<DbView, "filters" | "filterOp" | "sorts">, c: DbCtx, query = ""): Page[] {
  const all = allProps(db);
  let list = rowsOf(c.pages, db.id).filter((r) => passes(r, view.filters ?? [], view.filterOp, db, c));
  const q = query.trim().toLowerCase();
  if (q) list = list.filter((r) => all.some((p) => textValue(r, p, c).toLowerCase().includes(q)));
  if (view.sorts?.length) {
    list = [...list].sort((a, b) => {
      for (const s of view.sorts) {
        const prop = all.find((p) => p.id === s.propId);
        if (!prop) continue;
        const r = compare(a, b, prop, c, db);
        if (r !== 0) return s.dir === "desc" ? -r : r;
      }
      return a.order - b.order;
    });
  }
  return list;
}

// ---------------------------------------------------------------- grouping

export interface Group {
  key: string; // "" for "No <property>"
  label: string;
  color?: string;
  /** Status groups: which of To-do, In progress and Complete. */
  statusGroup?: StatusGroup;
}
export const GROUPABLE: PropType[] = [
  "select",
  "status",
  "multi_select",
  "person",
  "created_by",
  "last_edited_by",
  "checkbox",
  "date",
  "created_time",
  "last_edited_time",
  "text",
  "url",
  "email",
  "phone",
  "number",
  "relation",
  "formula",
  "rollup",
];
export const canGroupBy = (p: DbProperty) => p.id === "title" || GROUPABLE.includes(p.type);
export const GROUP_DATES: { id: GroupDate; label: string }[] = [
  { id: "relative", label: "Relative" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];
const RELATIVE_BUCKETS = ["Overdue", "Past 30 days", "Past 7 days", "Yesterday", "Today", "Tomorrow", "Next 7 days", "Next 30 days", "Later"];
function relativeBucket(day: string, now: number): string {
  const today = ymd(now);
  const diff = Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff <= 7) return "Next 7 days";
  if (diff > 7 && diff <= 30) return "Next 30 days";
  if (diff > 30) return "Later";
  if (diff < -1 && diff >= -7) return "Past 7 days";
  if (diff < -7 && diff >= -30) return "Past 30 days";
  return "Overdue";
}
function dateBucket(day: string, by: GroupDate, now: number): { key: string; label: string } {
  const [y, m, d] = day.split("-").map(Number);
  switch (by) {
    case "relative": {
      const b = relativeBucket(day, now);
      return { key: String(RELATIVE_BUCKETS.indexOf(b)).padStart(2, "0") + b, label: b };
    }
    case "day":
      return { key: day, label: formatWith(new Date(y, m - 1, d).getTime(), "MMM D, YYYY") };
    case "week": {
      const s = new Date(y, m - 1, d - new Date(y, m - 1, d).getDay());
      return { key: ymd(s), label: "Week of " + formatWith(s.getTime(), "MMM D, YYYY") };
    }
    case "year":
      return { key: String(y), label: String(y) };
    default:
      return { key: day.slice(0, 7), label: formatWith(new Date(y, m - 1, 1).getTime(), "MMMM YYYY") };
  }
}

/** The groups a row belongs to (several for multi-select, people and relations). */
export function groupKeys(row: Page, prop: DbProperty, view: Pick<DbView, "groupDate">, c: DbCtx, db?: Page): { key: string; label: string }[] {
  if (prop.id === "title") {
    const t = row.title?.trim() ?? "";
    return [{ key: t, label: t }];
  }
  switch (prop.type) {
    case "select":
    case "status": {
      const v = row.props?.[prop.id];
      const o = prop.options?.find((x) => x.id === v);
      return [o ? { key: o.id, label: o.name } : { key: "", label: "" }];
    }
    case "multi_select":
    case "person":
    case "relation":
    case "created_by":
    case "last_edited_by": {
      const ids = idsOn(row, prop, c);
      if (!ids.length) return [{ key: "", label: "" }];
      return ids.map((id) => ({
        key: id,
        label:
          prop.type === "multi_select"
            ? (prop.options?.find((o) => o.id === id)?.name ?? "")
            : prop.type === "relation"
              ? c.pages[id]?.title?.trim() || "Untitled"
              : (c.users[id]?.name ?? "Someone"),
      }));
    }
    case "checkbox":
      return row.props?.[prop.id] ? [{ key: "true", label: "Checked" }] : [{ key: "false", label: "Unchecked" }];
    case "date":
    case "created_time":
    case "last_edited_time": {
      const day =
        prop.type === "created_time" ? ymd(row.createdAt) : prop.type === "last_edited_time" ? ymd(row.updatedAt) : (dateVal(row.props?.[prop.id])?.start ?? "").slice(0, 10);
      if (!day) return [{ key: "", label: "" }];
      return [dateBucket(day, view.groupDate ?? (prop.type === "date" ? "month" : "relative"), c.now)];
    }
    case "number": {
      const n = numberOn(row, prop, c);
      return [n == null ? { key: "", label: "" } : { key: String(n), label: formatNumber(n, prop) }];
    }
    default: {
      const t = textValue(row, prop, c).trim();
      return [{ key: t, label: t }];
    }
  }
}

/** A view's groups in order, each with its rows. The "No <property>" group comes first, as in Notion. */
export function groupRows(rows: Page[], prop: DbProperty, view: Pick<DbView, "groupDate" | "hideEmptyGroups" | "hiddenGroups">, c: DbCtx, db?: Page): { group: Group; rows: Page[] }[] {
  const buckets = new Map<string, { group: Group; rows: Page[] }>();
  const add = (g: Group) => {
    if (!buckets.has(g.key)) buckets.set(g.key, { group: g, rows: [] });
    return buckets.get(g.key)!;
  };
  const none: Group = { key: "", label: "No " + prop.name };
  add(none);
  // Options and people come in their own order, even with no rows yet.
  if (prop.type === "select" || prop.type === "multi_select") for (const o of prop.options ?? []) add({ key: o.id, label: o.name, color: o.color });
  if (prop.type === "status") {
    for (const g of STATUS_GROUPS) for (const o of (prop.options ?? []).filter((x) => (x.group ?? "todo") === g.id)) add({ key: o.id, label: o.name, color: o.color, statusGroup: g.id });
  }
  if (prop.type === "checkbox") {
    add({ key: "true", label: "Checked" });
    add({ key: "false", label: "Unchecked" });
  }
  if (prop.type === "person") for (const u of Object.values(c.users).sort((a, b) => a.name.localeCompare(b.name))) add({ key: u.id, label: u.name });
  for (const r of rows) for (const k of groupKeys(r, prop, view, c, db)) add(k.key === "" ? none : { key: k.key, label: k.label }).rows.push(r);
  let list = [...buckets.values()];
  if (prop.type === "checkbox") list = list.filter((g) => g.group.key !== "");
  const fixedOrder = ["select", "multi_select", "status", "checkbox", "person"].includes(prop.type);
  if (!fixedOrder) {
    const sorted = list.filter((g) => g.group.key !== "").sort((a, b) => a.group.key.localeCompare(b.group.key, undefined, { numeric: true }));
    list = [list.find((g) => g.group.key === "")!, ...sorted];
  }
  const hidden = new Set(view.hiddenGroups ?? []);
  return list.filter((g) => !hidden.has(g.group.key) && (g.rows.length > 0 || (!view.hideEmptyGroups && g.group.key !== "")));
}

/** The value a row gets when it's dragged from one group to another, or null if it can't move there. */
export function valueForGroupMove(row: Page, prop: DbProperty, from: string, to: string, view: Pick<DbView, "groupDate">): { value: any } | null {
  if (prop.id === "title") return null;
  switch (prop.type) {
    case "select":
    case "status":
      return { value: to || undefined };
    case "checkbox":
      return { value: to === "true" || undefined };
    case "multi_select":
    case "person":
    case "relation": {
      const cur = asArray(row.props?.[prop.id]).filter((x) => x !== from);
      const next = to && !cur.includes(to) ? [...cur, to] : cur;
      return { value: next.length ? next : undefined };
    }
    case "date": {
      if (!to) return { value: undefined };
      if ((view.groupDate ?? "month") !== "day") return null;
      const old = dateVal(row.props?.[prop.id]);
      if (!old) return { value: to };
      return { value: storeDate(moveDate(old, to)) };
    }
    case "text":
    case "url":
    case "email":
    case "phone":
      return { value: to || undefined };
    case "number":
      return { value: to === "" ? undefined : Number(to) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- calculations

/** Which calculations make sense for a column. */
export function aggregatesFor(prop: DbProperty, c?: DbCtx, db?: Page): AggDef[] {
  const kind = prop.id === "title" ? "text" : kindOf(prop, c, db);
  return AGGREGATES.filter((a) => a.for === "any" || (a.for === "number" && kind === "number") || (a.for === "date" && kind === "date") || (a.for === "checkbox" && kind === "checkbox")).filter(
    (a) => !(kind === "checkbox" && ["count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"].includes(a.fn)),
  );
}

/** A column's calculation over the rows shown, as text ("12", "40%", "$1,200.00"). */
export function calculate(fn: string, rows: Page[], prop: DbProperty, c: DbCtx): string {
  const values: FValue[] = rows.map((r) => {
    if (prop.type === "checkbox") return !!r.props?.[prop.id];
    if (isEmptyValue(r, prop, c)) return null;
    try {
      return fvalue(r, prop, c);
    } catch {
      return null;
    }
  });
  const v = aggregate(fn, values);
  if (v == null) return "—";
  if (fn === "date_range") return `${v} day${v === 1 ? "" : "s"}`;
  if (isPercentAgg(fn)) return formatNumber(v as number, { numberFormat: "percent", decimals: 0 });
  if (fn.startsWith("count") || fn === "checked" || fn === "unchecked") return String(v);
  return showF(v, prop, c);
}

// ---------------------------------------------------------------- relations

/** Every change two-way relations need when a row's relation changes from `before` to `after`. */
export function relationEcho(pages: Pages, prop: DbProperty, rowId: string, before: string[], after: string[]): { rowId: string; propId: string; value: string[] | undefined }[] {
  const synced = prop.relation?.syncedPropId;
  if (!synced) return [];
  const out: { rowId: string; propId: string; value: string[] | undefined }[] = [];
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  for (const id of added) {
    const cur = asArray(pages[id]?.props?.[synced]);
    if (!cur.includes(rowId)) out.push({ rowId: id, propId: synced, value: [...cur, rowId] });
  }
  for (const id of removed) {
    const cur = asArray(pages[id]?.props?.[synced]);
    if (cur.includes(rowId)) {
      const next = cur.filter((x) => x !== rowId);
      out.push({ rowId: id, propId: synced, value: next.length ? next : undefined });
    }
  }
  return out;
}

// ---------------------------------------------------------------- changing a property's type

const STORES: PropType[] = ["text", "number", "select", "multi_select", "status", "date", "person", "files", "checkbox", "url", "email", "phone", "relation"];

/**
 * What a property's values become when its type changes, as Notion does it: text to number keeps the numbers,
 * text to select makes an option per value, select to multi-select keeps the choice, anything to text keeps
 * what it said. Returns new values per row (undefined clears) and the options the property should end up with.
 */
export function convertValues(
  db: Page,
  prop: DbProperty,
  to: PropType,
  c: DbCtx,
  nid: (n: number) => string,
): { values: Record<string, any>; options?: PropOption[] } {
  const rows = Object.values(c.pages).filter((p) => p.parentId === db.id && p.isRow);
  const values: Record<string, any> = {};
  if (!STORES.includes(to) || prop.type === to) return { values };
  const from = prop.type;
  const optionLike = (t: PropType) => t === "select" || t === "multi_select" || t === "status";
  let options: PropOption[] | undefined = prop.options ? [...prop.options] : undefined;
  const optionFor = (name: string): string => {
    options ??= [];
    const found = options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const o: PropOption = { id: nid(6), name, color: OPTION_COLORS[(options.length + 5) % OPTION_COLORS.length] };
    if (to === "status") o.group = "todo";
    options.push(o);
    return o.id;
  };
  for (const r of rows) {
    const raw = r.props?.[prop.id];
    const text = textValue(r, prop, c);
    let next: any;
    if (optionLike(from) && optionLike(to)) {
      const ids = asArray(raw);
      next = to === "multi_select" ? (ids.length ? ids : undefined) : ids[0];
    } else if (from === to) next = raw;
    else
      switch (to) {
        case "text":
        case "url":
        case "email":
        case "phone":
          next = from === "number" && typeof raw === "number" ? String(raw) : text || undefined;
          break;
        case "number": {
          const n = typeof raw === "number" ? raw : parseFloat(String(text).replace(/[^\d.eE+-]/g, ""));
          next = Number.isFinite(n) ? n : undefined;
          break;
        }
        case "checkbox":
          next = from === "number" ? (raw ? true : undefined) : /^(true|yes|y|1|x|✓|✔|checked|done)$/i.test(String(text).trim()) || undefined;
          break;
        case "select":
        case "status": {
          const t = String(text).split(",")[0]?.trim();
          next = t ? optionFor(t) : undefined;
          break;
        }
        case "multi_select": {
          const ids = String(text)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .map(optionFor);
          next = ids.length ? [...new Set(ids)] : undefined;
          break;
        }
        case "date": {
          if (from === "created_time" || from === "last_edited_time") next = ymd(from === "created_time" ? r.createdAt : r.updatedAt);
          else {
            const d = parseDateText(String(raw ?? text));
            next = d ? ymd(d.start) : undefined;
          }
          break;
        }
        case "person": {
          const ids = from === "created_by" ? [r.createdBy] : from === "last_edited_by" ? [r.updatedBy] : asArray(raw);
          const known = ids.filter((id): id is string => !!id && !!c.users[id]);
          next = known.length ? known : undefined;
          break;
        }
        default:
          next = undefined;
      }
    if (JSON.stringify(next) !== JSON.stringify(raw)) values[r.id] = next;
  }
  return { values, options: optionLike(to) ? (options ?? []) : undefined };
}

// ---------------------------------------------------------------- new properties and views

export function statusOptions(nid: (n: number) => string): PropOption[] {
  return [
    { id: nid(6), name: "Not started", color: "gray", group: "todo" },
    { id: nid(6), name: "In progress", color: "blue", group: "doing" },
    { id: nid(6), name: "Done", color: "green", group: "done" },
  ];
}

/** Values a new row starts with: its unique IDs. Returns the props to set and the database's updated properties. */
export function newRowIds(pages: Pages, db: Page): { props: Record<string, number>; properties: DbProperty[] } | null {
  const ids = (db.properties ?? []).filter((p) => p.type === "unique_id");
  if (!ids.length) return null;
  const props: Record<string, number> = {};
  const properties = (db.properties ?? []).map((p) => {
    if (p.type !== "unique_id") return p;
    let next = p.nextId;
    if (next == null) {
      // First row since the property was added: carry on after the rows already there.
      next = Object.values(pages).filter((r) => r.parentId === db.id && r.isRow).length + 1;
    }
    props[p.id] = next;
    return { ...p, nextId: next + 1 };
  });
  return { props, properties };
}

/** IDs for every existing row, oldest first, when an ID property is added. */
export function backfillIds(pages: Pages, dbId: string, propId: string): { ids: Record<string, number>; next: number } {
  const rows = Object.values(pages)
    .filter((p) => p.parentId === dbId && p.isRow)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const ids: Record<string, number> = {};
  rows.forEach((r, i) => (ids[r.id] = i + 1));
  return { ids, next: rows.length + 1 };
}

export function defaultViewName(type: ViewType): string {
  return VIEW_LABEL[type];
}
