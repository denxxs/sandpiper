// Changes to a workspace's page tree (its document: the "pages", "meta" and "users" maps), run inside that
// workspace's document room. They follow the same rules as the app (src/store.ts): nesting depth, rows belong to
// databases, a trashed page's parent may be gone, locked pages stay as they are.
import * as Y from "yjs";
import {
  aggregatesFor,
  allProps,
  asArray,
  backfillIds,
  canGroupBy,
  canMoveInto,
  canNestIn,
  ChartConfig,
  checkFormula,
  convertValues,
  COVER_PRESETS,
  DATE_FORMATS,
  dbCtx,
  DbProperty,
  DbView,
  descendantsOf,
  findOption,
  FONTS,
  GROUP_DATES,
  isComputed,
  isGroup,
  isTrashed,
  kindOf,
  lockedBy,
  MAX_DEPTH,
  newRowIds,
  nextOptionColor,
  nextOrder,
  NUMBER_FORMATS,
  orderNear,
  Page,
  Pages,
  pageTitle,
  Person,
  PROP_TYPE_LABEL,
  PROP_TYPES,
  PropOption,
  PropType,
  propertyOf,
  relationEcho,
  ROLLUP_FNS,
  StatusGroup,
  statusOptions,
  storedFilters,
  storedValue,
  TITLE,
  VIEW_LABEL,
  VIEW_TYPES,
  ViewType,
} from "./pages";
import { fail, isObj, nid, OpCtx, OPTION_COLORS } from "./util";

const yPages = (doc: Y.Doc) => doc.getMap<Y.Map<any>>("pages");
const json = (doc: Y.Doc) => yPages(doc).toJSON() as Pages;

function entry(doc: Y.Doc, pages: Pages, id: string, what = "page"): { page: Page; map: Y.Map<any> } {
  const map = yPages(doc).get(id);
  const page = pages[id];
  if (!map || !page) fail(`There's no ${what} with id "${id}" in this workspace.`);
  return { page, map };
}
function live(pages: Pages, id: string, what = "page") {
  if (isTrashed(pages, id)) fail(`That ${what} is in the trash. Restore it first.`);
}
function notLocked(pages: Pages, id: string) {
  const by = lockedBy(pages, id);
  if (by) fail(`"${pageTitle(by)}" is locked, so it can't be changed. Unlock it first (update_page with locked: false).`);
}
function database(doc: Y.Doc, pages: Pages, id: string): { db: Page; map: Y.Map<any> } {
  const { page, map } = entry(doc, pages, id, "database");
  if (page.kind !== "database") fail(`"${pageTitle(page)}" is a page, not a database.`);
  live(pages, id, "database");
  return { db: page, map };
}

function touch(m: Y.Map<any>, ctx: OpCtx) {
  m.set("updatedAt", Date.now());
  m.set("updatedBy", ctx.userId);
}

function writePage(doc: Y.Doc, page: Page) {
  const m = new Y.Map<any>();
  for (const [k, v] of Object.entries(page)) {
    if (v === undefined) continue;
    if (k === "props") {
      const pm = new Y.Map<any>();
      for (const [pk, pv] of Object.entries(v as object)) if (pv !== undefined) pm.set(pk, pv);
      m.set("props", pm);
    } else m.set(k, v);
  }
  yPages(doc).set(page.id, m);
}

// ---------------------------------------------------------------- page fields

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Checks the page settings an AI may set, returning them as the app stores them (undefined clears one). */
function pageFields(raw: Record<string, unknown>): Partial<Page> {
  const out: Partial<Page> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    switch (k) {
      case "title":
        out.title = String(v ?? "").replace(/\n/g, " ").slice(0, 500);
        break;
      case "icon": {
        const s = clean(v, 16);
        if (s && /[A-Za-z0-9]{3,}/.test(s)) fail("icon must be an emoji (like 📚), not a word.");
        out.icon = s || undefined;
        break;
      }
      case "cover": {
        const s = String(v ?? "").trim();
        if (s && !COVER_PRESETS.includes(s) && !/^(https:\/\/|\/uploads\/)/.test(s)) {
          fail(`cover must be one of ${COVER_PRESETS.join(", ")} (gradients and colours), an image address (https://…) or an uploaded file (/uploads/…).`);
        }
        out.cover = s || undefined;
        break;
      }
      case "font":
        if (!(FONTS as readonly string[]).includes(String(v))) fail(`font must be one of: ${FONTS.join(", ")}.`);
        out.font = v as Page["font"];
        break;
      case "smallText":
      case "fullWidth":
      case "locked":
        out[k] = v ? true : undefined;
        break;
      case "description":
        out.description = String(v ?? "").slice(0, 2000) || undefined;
        break;
      default:
        fail(`Unknown page setting "${k}".`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- databases

function uniqueName(existing: DbProperty[], base: string) {
  let n = base;
  for (let i = 2; existing.some((p) => p.name.toLowerCase() === n.toLowerCase()); i++) n = `${base} ${i}`;
  return n;
}

function optionColor(c: unknown, fallback: string): string {
  if (c === undefined || c === null || c === "") return fallback;
  if (!(OPTION_COLORS as readonly string[]).includes(String(c))) fail(`Option colours: ${OPTION_COLORS.join(", ")}.`);
  return String(c);
}

const STATUS_GROUP_IDS: Record<string, StatusGroup> = { todo: "todo", "to-do": "todo", doing: "doing", "in progress": "doing", in_progress: "doing", done: "done", complete: "done" };
function statusGroup(g: unknown): StatusGroup {
  if (g === undefined || g === null || g === "") return "todo";
  const s = STATUS_GROUP_IDS[String(g).toLowerCase()];
  if (!s) fail('A status option\'s group is "todo", "in_progress" or "done".');
  return s;
}

/** Options from an AI: names, or {name, color, group}. */
function newOptions(prop: DbProperty, raw: unknown): PropOption[] {
  const out: PropOption[] = [...(prop.options ?? [])];
  for (const o of Array.isArray(raw) ? raw : []) {
    const optName = clean(typeof o === "string" ? o : o?.name, 100);
    if (!optName || out.some((x) => x.name.toLowerCase() === optName.toLowerCase())) continue;
    const opt: PropOption = { id: nid(6), name: optName, color: optionColor(typeof o === "string" ? undefined : o?.color, nextOptionColor({ ...prop, options: out })) };
    if (prop.type === "status") opt.group = statusGroup(typeof o === "string" ? undefined : o?.group);
    out.push(opt);
  }
  return out;
}

/** Finds a database in this workspace by id, link or exact title. */
function databaseRef(pages: Pages, ref: unknown): Page {
  const r = String(ref ?? "").trim();
  const id = /#\/([A-Za-z0-9]+)/.exec(r)?.[1] ?? r;
  const dbs = Object.values(pages).filter((p) => p.kind === "database" && !isTrashed(pages, p.id));
  const byId = dbs.find((p) => p.id === id);
  const named = byId ? [] : dbs.filter((p) => pageTitle(p).toLowerCase() === r.toLowerCase());
  if (named.length > 1) fail(`Several databases are called "${r}": ${named.map((d) => d.id).join(", ")}. Give the id of the one you mean.`);
  const hit = byId ?? named[0];
  if (!hit) fail(`There's no database "${r}" in this workspace. Databases here: ${dbs.map((d) => `${pageTitle(d)} (${d.id})`).join(", ") || "none"}.`);
  return hit;
}

/** A button action's value, as stored: specials for "now", "me", "toggle" and "clear". */
function buttonValue(target: DbProperty, v: unknown, people: Person[], pages: Pages): any {
  const s = typeof v === "string" ? v.toLowerCase() : null;
  if (v === null || s === "clear" || s === "empty") return { clear: true };
  if (target.type === "checkbox" && s === "toggle") return { toggle: true };
  if (target.type === "date" && (s === "now" || s === "today")) return { now: true };
  if (target.type === "person" && s === "me") return { me: true };
  if (target.id === "title") return String(v ?? "");
  return storedValue(target, v, people, () => fail(`Add "${v}" as an option of "${target.name}" first.`), pages);
}

/**
 * Applies the settings an AI gives a property (for its type): number format, decimals, bars and rings, date
 * formats, options, relation, rollup, formula, ID prefix, button, description. Returns the property as stored,
 * plus whether a two-way relation was asked for.
 */
function propertySettings(prop: DbProperty, raw: any, db: Page, pages: Pages, people: Person[]): { prop: DbProperty; twoWay?: boolean } {
  const p: DbProperty = { ...prop };
  const t = p.type;
  const only = (types: PropType[], key: string) => {
    if (!types.includes(t)) fail(`${key} is for ${types.map((x) => PROP_TYPE_LABEL[x]).join(", ")} properties, not ${PROP_TYPE_LABEL[t]}.`);
  };
  const numeric = t === "number" || t === "formula" || t === "rollup";
  const dated = ["date", "created_time", "last_edited_time", "formula", "rollup"].includes(t);
  if (raw.description !== undefined) p.description = String(raw.description ?? "").slice(0, 1000) || undefined;
  if (raw.number_format !== undefined) {
    if (!numeric) only(["number", "formula", "rollup"], "number_format");
    if (raw.number_format !== null && !NUMBER_FORMATS.some((f) => f.id === raw.number_format)) fail(`number_format: ${NUMBER_FORMATS.map((f) => f.id).join(", ")}.`);
    p.numberFormat = raw.number_format === "number" || raw.number_format === null ? undefined : raw.number_format;
  }
  if (raw.decimals !== undefined) {
    if (!numeric) only(["number", "formula", "rollup"], "decimals");
    if (raw.decimals !== null && (!Number.isInteger(raw.decimals) || raw.decimals < 0 || raw.decimals > 8)) fail("decimals is 0 to 8 (or null for the default).");
    p.decimals = raw.decimals ?? undefined;
  }
  if (raw.show_as !== undefined) {
    if (!numeric) only(["number", "formula", "rollup"], "show_as");
    if (!["number", "bar", "ring"].includes(raw.show_as)) fail('show_as is "number", "bar" or "ring".');
    p.showAs = raw.show_as === "number" ? undefined : raw.show_as;
  }
  if (raw.bar_color !== undefined) p.barColor = optionColor(raw.bar_color, "green");
  if (raw.divide_by !== undefined) {
    const n = Number(raw.divide_by);
    if (!Number.isFinite(n) || n <= 0) fail("divide_by is a number above 0 (a full bar or ring).");
    p.divideBy = n;
  }
  if (raw.show_number !== undefined) p.showNumber = raw.show_number ? undefined : false;
  if (raw.date_format !== undefined) {
    if (!dated) only(["date", "created_time", "last_edited_time", "formula", "rollup"], "date_format");
    if (!DATE_FORMATS.some((f) => f.id === raw.date_format)) fail(`date_format: ${DATE_FORMATS.map((f) => f.id).join(", ")}.`);
    p.dateFormat = raw.date_format === "default" ? undefined : raw.date_format;
  }
  if (raw.time_format !== undefined) {
    if (!["12h", "24h"].includes(raw.time_format)) fail('time_format is "12h" or "24h".');
    p.timeFormat = raw.time_format === "12h" ? undefined : raw.time_format;
  }
  if (raw.options !== undefined && (raw.options as any[])?.length) {
    only(["select", "multi_select", "status"], "options");
    p.options = newOptions(p, raw.options);
  }
  let twoWay: boolean | undefined;
  if (raw.related_database !== undefined) {
    only(["relation"], "related_database");
    const target = databaseRef(pages, raw.related_database);
    if (p.relation?.dbId && p.relation.dbId !== target.id && p.relation.syncedPropId) fail("Turn two_way off before relating this property to another database.");
    p.relation = { dbId: target.id, syncedPropId: p.relation?.dbId === target.id ? p.relation.syncedPropId : undefined };
  }
  if (raw.two_way !== undefined) {
    only(["relation"], "two_way");
    twoWay = !!raw.two_way;
  }
  if (t === "relation" && !p.relation) fail('A relation needs related_database: the database (id or title) its values come from.');
  if (raw.rollup !== undefined) {
    only(["rollup"], "rollup");
    const r = raw.rollup ?? {};
    const rel = r.relation_property !== undefined ? propertyOf(db, r.relation_property, false) : db.properties?.find((x) => x.id === p.rollup?.relationPropId);
    if (!rel || rel.type !== "relation") fail("rollup.relation_property must be a Relation property of this database.");
    const target = pages[rel.relation!.dbId];
    if (!target) fail("That relation's database no longer exists.");
    const tp = r.rollup_property !== undefined ? propertyOf(target, r.rollup_property) : (allProps(target).find((x) => x.id === p.rollup?.targetPropId) ?? TITLE);
    const fn = r.calculate ?? p.rollup?.fn ?? "show_original";
    if (!ROLLUP_FNS.some((f) => f.fn === fn)) fail(`rollup.calculate: ${ROLLUP_FNS.map((f) => f.fn).join(", ")}.`);
    p.rollup = { relationPropId: rel.id, targetPropId: tp.id, fn };
  }
  if (t === "rollup" && !p.rollup) {
    const rel = db.properties?.find((x) => x.type === "relation");
    if (!rel) fail("A rollup needs a Relation property on this database first.");
    p.rollup = { relationPropId: rel.id, targetPropId: "title", fn: "show_original" };
  }
  if (raw.expression !== undefined) {
    only(["formula"], "expression");
    const src = String(raw.expression ?? "");
    const problem = checkFormula(src);
    if (problem) fail(`That formula doesn't read: ${problem}`);
    p.formula = src;
  }
  if (t === "formula" && p.formula == null) p.formula = "";
  if (raw.prefix !== undefined) {
    only(["unique_id"], "prefix");
    p.prefix = String(raw.prefix ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 12) || undefined;
  }
  if (raw.button !== undefined) {
    only(["button"], "button");
    const b = raw.button ?? {};
    const label = b.label !== undefined ? clean(b.label, 60) : p.button?.label;
    let actions = p.button?.actions ?? [];
    if (b.actions !== undefined) {
      if (!Array.isArray(b.actions)) fail('button.actions is a list like [{"property": "Done", "value": true}].');
      actions = b.actions.map((x: any) => {
        const target = propertyOf(db, x?.property);
        if (isComputed(target.type) || target.type === "files" || target.type === "relation") fail(`A button can't set "${target.name}" (${PROP_TYPE_LABEL[target.type]}).`);
        return { propId: target.id, value: buttonValue(target, x?.value, people, pages) };
      });
    }
    p.button = { label: label || p.name, actions };
  }
  if (t === "button" && !p.button) p.button = { label: p.name, actions: [] };
  return { prop: p, twoWay };
}

function newProperty(existing: DbProperty[], raw: any, db: Page, pages: Pages, people: Person[]): { prop: DbProperty; twoWay?: boolean } {
  if (!isObj(raw)) fail('A property is {"name": "…", "type": "…"}.');
  const type = String(raw.type ?? "text") as PropType;
  if (!PROP_TYPES.includes(type)) fail(`Property types: ${PROP_TYPES.join(", ")}.`);
  const name = clean(raw.name, 100) || PROP_TYPE_LABEL[type];
  if (name.toLowerCase() === "name") fail('"Name" is the title column every database already has. Pick another name.');
  const base: DbProperty = { id: nid(6), name: uniqueName(existing, name), type };
  if (type === "select" || type === "multi_select") base.options = [];
  if (type === "status") base.options = raw.options?.length ? [] : statusOptions(nid);
  const r = propertySettings(base, raw, { ...db, properties: [...existing] }, pages, people);
  return { prop: r.prop, twoWay: type === "relation" ? r.twoWay !== false : undefined };
}

function newView(type: ViewType, properties: DbProperty[], name?: string): DbView {
  const v: DbView = { id: nid(6), name: name || VIEW_LABEL[type], type, filters: [], sorts: [] };
  const groupable = properties.find((p) => p.type === "status") ?? properties.find((p) => p.type === "select");
  if (type === "board") v.groupBy = groupable?.id;
  if (type === "calendar" || type === "timeline") v.dateProp = properties.find((p) => p.type === "date")?.id;
  if (type === "chart") v.chart = { type: "bar", x: groupable?.id, y: { fn: "count" } };
  return v;
}

/** The starter properties the app gives a new database. */
function defaultProperties(view: ViewType): DbProperty[] {
  const status: DbProperty = { id: nid(6), name: "Status", type: "status", options: statusOptions(nid) };
  const tags: DbProperty = { id: nid(6), name: "Tags", type: "multi_select", options: [] };
  const date: DbProperty = { id: nid(6), name: "Date", type: "date" };
  return view === "board" ? [status, tags, date] : view === "calendar" || view === "timeline" ? [date, tags, status] : [tags, status, date];
}

const dateLike = (p: DbProperty) => p.type === "date" || p.type === "created_time" || p.type === "last_edited_time";
const CHART_TYPES = ["bar", "hbar", "line", "donut"];

/** Applies a view's settings (filters, sorts, grouping, calculations, layout options…) written by an AI. */
function viewPatch(db: Page, view: DbView, raw: any, people: Person[], pages: Pages): DbView {
  const props = db.properties ?? [];
  const c = dbCtx(pages, {});
  const v: DbView = { ...view };
  const nameOrNull = (key: string, test: (p: DbProperty) => boolean, msg: string, set: (id: string | undefined) => void) => {
    if (raw[key] === undefined) return;
    if (raw[key] === null) return set(undefined);
    const p = propertyOf(db, raw[key]);
    if (!test(p)) fail(msg);
    set(p.id);
  };
  if (raw.name !== undefined) v.name = clean(raw.name, 100) || v.name;
  if (raw.type !== undefined) {
    if (!VIEW_TYPES.includes(raw.type)) fail(`View types: ${VIEW_TYPES.join(", ")}.`);
    v.type = raw.type;
  }
  if (raw.filters !== undefined) v.filters = storedFilters(db, raw.filters, people, () => nid(6), c);
  if (raw.filter_mode !== undefined) {
    if (!["and", "or"].includes(raw.filter_mode)) fail('filter_mode is "and" (rows match every filter) or "or" (any filter).');
    v.filterOp = raw.filter_mode === "or" ? "or" : undefined;
  }
  if (raw.sorts !== undefined) {
    if (!Array.isArray(raw.sorts)) fail('sorts is a list like [{"property": "Date", "direction": "asc"}].');
    v.sorts = raw.sorts.map((s: any) => {
      const dir = String(s?.direction ?? s?.dir ?? "asc").toLowerCase();
      if (dir !== "asc" && dir !== "desc") fail('A sort direction is "asc" or "desc".');
      return { propId: propertyOf(db, s?.property ?? s?.propId).id, dir: dir as "asc" | "desc" };
    });
  }
  nameOrNull("group_by", canGroupBy, "That property can't group rows (files, buttons and IDs can't).", (id) => {
    v.groupBy = id;
    v.hiddenGroups = undefined;
    v.collapsedGroups = undefined;
  });
  if (raw.group_dates_by !== undefined) {
    if (!GROUP_DATES.some((g) => g.id === raw.group_dates_by)) fail(`group_dates_by: ${GROUP_DATES.map((g) => g.id).join(", ")}.`);
    v.groupDate = raw.group_dates_by;
  }
  if (raw.hide_empty_groups !== undefined) v.hideEmptyGroups = raw.hide_empty_groups ? true : undefined;
  if (raw.color_columns !== undefined) v.colorGroups = raw.color_columns ? true : undefined;
  if (raw.hidden_groups !== undefined) {
    if (!Array.isArray(raw.hidden_groups)) fail("hidden_groups is a list of group names.");
    const gp = allProps(db).find((p) => p.id === v.groupBy);
    if (!gp) fail("Set group_by before hiding groups.");
    v.hiddenGroups = raw.hidden_groups.map((g: string) => {
      if (g === null || g === "" || /^no /i.test(String(g))) return "";
      return findOption(gp, g)?.id ?? people.find((x) => x.name.toLowerCase() === String(g).toLowerCase())?.id ?? String(g);
    });
    if (!v.hiddenGroups!.length) v.hiddenGroups = undefined;
  }
  nameOrNull("date_property", (p) => dateLike(p) || (p.type === "formula" && kindOf(p, c, db) === "date"), "Calendars and timelines place rows by a date property.", (id) => (v.dateProp = id));
  nameOrNull("end_date_property", (p) => p.type === "date", "A timeline's end date is a date property.", (id) => (v.endProp = id));
  if (raw.timeline_zoom !== undefined) {
    if (!["day", "week", "month", "quarter", "year"].includes(raw.timeline_zoom)) fail("timeline_zoom: day, week, month, quarter, year.");
    v.timelineScale = raw.timeline_zoom === "week" ? undefined : raw.timeline_zoom;
  }
  if (raw.show_table !== undefined) v.showTable = raw.show_table ? undefined : false;
  if (raw.hidden_properties !== undefined) {
    if (!Array.isArray(raw.hidden_properties)) fail("hidden_properties is a list of property names.");
    const hidden: string[] = raw.hidden_properties.map((p: string) => propertyOf(db, p, false).id);
    v.hidden = hidden.length ? hidden : undefined;
  }
  if (raw.column_widths !== undefined) {
    if (!isObj(raw.column_widths)) fail('column_widths is like {"Name": 280, "Status": 140}.');
    const w: Record<string, number> = { ...(v.widths ?? {}) };
    for (const [k, px] of Object.entries(raw.column_widths)) {
      const n = Number(px);
      if (!Number.isFinite(n) || n < 60 || n > 1200) fail("Column widths are 60 to 1200 pixels.");
      w[propertyOf(db, k).id] = Math.round(n);
    }
    v.widths = w;
  }
  if (raw.wrap !== undefined) v.wrap = raw.wrap ? true : undefined;
  if (raw.wrap_columns !== undefined) {
    if (!Array.isArray(raw.wrap_columns)) fail("wrap_columns is a list of property names.");
    const cols = raw.wrap_columns.map((p: string) => propertyOf(db, p).id);
    v.wrapCols = cols.length ? cols : undefined;
  }
  if (raw.freeze_columns !== undefined) {
    const n = Number(raw.freeze_columns);
    if (!Number.isInteger(n) || n < 0 || n > props.length + 1) fail("freeze_columns is how many columns from the left stay put (0 turns it off).");
    v.freeze = n || undefined;
  }
  if (raw.calculations !== undefined) {
    if (!isObj(raw.calculations)) fail('calculations is like {"Estimate": "sum", "Name": "count_all", "Done": null}.');
    const calcs = { ...(v.calcs ?? {}) };
    for (const [k, fn] of Object.entries(raw.calculations)) {
      const p = propertyOf(db, k);
      if (fn === null || fn === "none") delete calcs[p.id];
      else {
        const ok = aggregatesFor(p, c, db).map((a) => a.fn);
        if (!ok.includes(String(fn))) fail(`"${p.name}" can be calculated with: ${ok.join(", ")}.`);
        calcs[p.id] = String(fn);
      }
    }
    v.calcs = Object.keys(calcs).length ? calcs : undefined;
  }
  if (raw.open_pages_in !== undefined) {
    if (!["side_peek", "center_peek", "full_page"].includes(raw.open_pages_in)) fail('open_pages_in: "side_peek", "center_peek" or "full_page".');
    v.openIn = raw.open_pages_in === "center_peek" ? "center" : raw.open_pages_in === "full_page" ? "full" : undefined;
  }
  if (raw.show_page_icons !== undefined) v.showIcons = raw.show_page_icons ? undefined : false;
  if (raw.card_preview !== undefined) {
    if (raw.card_preview === "none" || raw.card_preview === "page_cover" || raw.card_preview === null) v.cardPreview = raw.card_preview === "page_cover" ? "cover" : "none";
    else {
      const p = propertyOf(db, raw.card_preview, false);
      if (p.type !== "files") fail('card_preview is "none", "page_cover" or a Files & media property.');
      v.cardPreview = p.id;
    }
  }
  if (raw.card_size !== undefined) {
    if (!["small", "medium", "large"].includes(raw.card_size)) fail("card_size: small, medium, large.");
    v.cardSize = raw.card_size === "medium" ? undefined : raw.card_size;
  }
  if (raw.fit_image !== undefined) v.fitImage = raw.fit_image ? true : undefined;
  if (raw.week_starts_on !== undefined) {
    if (!["sunday", "monday"].includes(raw.week_starts_on)) fail('week_starts_on: "sunday" or "monday".');
    v.weekStart = raw.week_starts_on === "monday" ? 1 : undefined;
  }
  if (raw.show_weekends !== undefined) v.showWeekends = raw.show_weekends ? undefined : false;
  if (raw.chart !== undefined) {
    const ch = raw.chart ?? {};
    const cur: ChartConfig = v.chart ?? { type: "bar", y: { fn: "count" } };
    const next: ChartConfig = { ...cur };
    if (ch.type !== undefined) {
      if (!CHART_TYPES.includes(ch.type)) fail(`chart.type: ${CHART_TYPES.join(", ")} (hbar is horizontal bars).`);
      next.type = ch.type;
    }
    if (ch.group_by !== undefined) {
      const p = propertyOf(db, ch.group_by);
      if (!canGroupBy(p)) fail("A chart groups rows by a property like a select, status, person, checkbox or date.");
      next.x = p.id;
    }
    if (ch.value !== undefined) {
      const val = ch.value ?? "count";
      if (val === "count") next.y = { fn: "count" };
      else {
        const m = /^(sum|average|median|min|max)\s+of\s+(.+)$/i.exec(String(val));
        if (!m) fail('chart.value is "count" or like "sum of Estimate" (sum, average, median, min, max).');
        const p = propertyOf(db, m[2], false);
        if (kindOf(p, c, db) !== "number") fail(`"${p.name}" isn't a number, so it can't be summed.`);
        next.y = { fn: m[1].toLowerCase(), propId: p.id };
      }
    }
    if (ch.split_by !== undefined) next.stack = ch.split_by === null ? undefined : propertyOf(db, ch.split_by).id;
    if (ch.sort !== undefined) next.sortBy = ch.sort === "value" ? "y" : undefined;
    if (ch.hide_empty !== undefined) next.hideEmpty = ch.hide_empty ? true : undefined;
    if (ch.show_values !== undefined) next.showLabels = ch.show_values ? true : undefined;
    for (const k of Object.keys(next) as (keyof ChartConfig)[]) if (next[k] === undefined) delete next[k];
    v.chart = next;
  }
  if (v.type === "board" && !v.groupBy) v.groupBy = (props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select"))?.id;
  if ((v.type === "calendar" || v.type === "timeline") && !v.dateProp) v.dateProp = props.find((p) => p.type === "date")?.id;
  if (v.type === "chart" && !v.chart) v.chart = { type: "bar", x: (props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select"))?.id, y: { fn: "count" } };
  for (const k of Object.keys(v) as (keyof DbView)[]) if (v[k] === undefined) delete v[k];
  return v;
}

function findView(db: Page, ref: string): DbView {
  const views = db.views ?? [];
  const r = String(ref ?? "");
  const v = views.find((x) => x.id === r) ?? views.find((x) => x.name.toLowerCase() === r.toLowerCase());
  if (!v) fail(`"${pageTitle(db)}" has no view "${ref}". Its views: ${views.map((x) => x.name).join(", ")}.`);
  return v;
}

const moveItem = <T>(list: T[], from: number, to: unknown): T[] => {
  if (to === undefined || to === null) return list;
  const n = Number(to);
  if (!Number.isInteger(n) || n < 0) fail("position is a number from 0 (first).");
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(Math.min(n, out.length), 0, it);
  return out;
};

/** Sets one value on a row's props map (an empty value clears it). */
function setProp(map: Y.Map<any>, propId: string, value: unknown) {
  let props = map.get("props");
  if (!(props instanceof Y.Map)) {
    props = new Y.Map<any>();
    map.set("props", props);
  }
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) props.delete(propId);
  else props.set(propId, value);
}

/**
 * Sets row values by property name, adding options for new names. Writes the database's properties if that
 * happened, and keeps two-way relations in step on the other side.
 */
function applyValues(doc: Y.Doc, pages: Pages, db: Page, dbMap: Y.Map<any>, rowId: string, values: unknown, people: Person[], props: Y.Map<any> | Record<string, any>) {
  if (values === undefined) return;
  if (!isObj(values)) fail('values is an object like {"Status": "Done", "Due": "2026-12-01"}.');
  let properties = db.properties ?? [];
  let changed = false;
  for (const [ref, value] of Object.entries(values)) {
    const prop = propertyOf({ ...db, properties }, ref, false);
    const stored = storedValue(
      prop,
      value,
      people,
      (name) => {
        const opt: PropOption = { id: nid(6), name: clean(name, 100), color: nextOptionColor(prop) };
        if (!opt.name) fail(`An option for "${prop.name}" needs a name.`);
        prop.options = [...(prop.options ?? []), opt];
        properties = properties.map((p) => (p.id === prop.id ? { ...prop } : p));
        changed = true;
        return opt;
      },
      pages,
    );
    const before = asArray(props instanceof Y.Map ? props.get(prop.id) : props[prop.id]);
    if (props instanceof Y.Map) {
      if (stored === undefined) props.delete(prop.id);
      else props.set(prop.id, stored);
    } else if (stored === undefined) delete props[prop.id];
    else props[prop.id] = stored;
    if (prop.type === "relation") {
      for (const e of relationEcho(pages, prop, rowId, before, asArray(stored))) {
        const other = yPages(doc).get(e.rowId);
        if (other) setProp(other, e.propId, e.value);
        const p = pages[e.rowId];
        if (p) pages[e.rowId] = { ...p, props: { ...(p.props ?? {}), [e.propId]: e.value } };
      }
    }
  }
  if (changed) {
    dbMap.set("properties", properties);
    db.properties = properties;
    pages[db.id] = db;
  }
}

/** Adds the mirror of a two-way relation on the other database (or this one, for a self-relation). */
function addMirror(doc: Y.Doc, pages: Pages, db: Page, prop: DbProperty, list: DbProperty[]): DbProperty[] {
  const target = pages[prop.relation!.dbId];
  const mirrorId = nid(6);
  prop.relation = { dbId: prop.relation!.dbId, syncedPropId: mirrorId };
  if (target.id === db.id) {
    return [...list.map((p) => (p.id === prop.id ? prop : p)), { id: mirrorId, name: uniqueName(list, "Related " + prop.name), type: "relation", relation: { dbId: db.id, syncedPropId: prop.id } }];
  }
  const mirror: DbProperty = { id: mirrorId, name: uniqueName(target.properties ?? [], pageTitle(db)), type: "relation", relation: { dbId: db.id, syncedPropId: prop.id } };
  yPages(doc).get(target.id)!.set("properties", [...(target.properties ?? []), mirror]);
  // Fill it from what's already related.
  const back = new Map<string, string[]>();
  for (const r of Object.values(pages)) {
    if (r.parentId !== db.id || !r.isRow) continue;
    for (const other of asArray(r.props?.[prop.id])) back.set(other, [...(back.get(other) ?? []), r.id]);
  }
  for (const [other, ids] of back) {
    const m = yPages(doc).get(other);
    if (m) setProp(m, mirrorId, ids);
  }
  return list.map((p) => (p.id === prop.id ? prop : p));
}

/** Turns the mirror of a two-way relation into a one-way relation of its own (or removes it, when asked). */
function dropMirror(doc: Y.Doc, pages: Pages, prop: DbProperty, remove: boolean) {
  const synced = prop.relation?.syncedPropId;
  const other = prop.relation ? pages[prop.relation.dbId] : undefined;
  if (!synced || !other) return;
  const list = (other.properties ?? []).filter((p) => !(remove && p.id === synced)).map((p) => (p.id === synced ? { ...p, relation: { dbId: p.relation!.dbId } } : p));
  yPages(doc).get(other.id)?.set("properties", list);
}

/** A view with a deleted property let go of everywhere it was used. */
function withoutProp(v: DbView, propId: string): DbView {
  const out: DbView = {
    ...v,
    filters: v.filters
      .filter((f) => isGroup(f) || f.propId !== propId)
      .map((f) => (isGroup(f) ? { ...f, filters: f.filters.filter((x) => x.propId !== propId) } : f))
      .filter((f) => !isGroup(f) || f.filters.length),
    sorts: v.sorts.filter((s) => s.propId !== propId),
    groupBy: v.groupBy === propId ? undefined : v.groupBy,
    dateProp: v.dateProp === propId ? undefined : v.dateProp,
    endProp: v.endProp === propId ? undefined : v.endProp,
    hidden: v.hidden?.filter((h) => h !== propId),
    wrapCols: v.wrapCols?.filter((h) => h !== propId),
    calcs: v.calcs ? Object.fromEntries(Object.entries(v.calcs).filter(([k]) => k !== propId)) : undefined,
    cardPreview: v.cardPreview === propId ? undefined : v.cardPreview,
    chart: v.chart
      ? { ...v.chart, x: v.chart.x === propId ? undefined : v.chart.x, stack: v.chart.stack === propId ? undefined : v.chart.stack, y: v.chart.y?.propId === propId ? { fn: "count" } : v.chart.y }
      : undefined,
  };
  for (const k of Object.keys(out) as (keyof DbView)[]) if (out[k] === undefined) delete out[k];
  if (out.hidden && !out.hidden.length) delete out.hidden;
  return out;
}

// ---------------------------------------------------------------- operations

export interface TreeCtx extends OpCtx {
  people?: Person[];
}

export function treeOp(doc: Y.Doc, op: string, a: any, ctx: TreeCtx): any {
  const pages = json(doc);
  const people = ctx.people ?? [];
  switch (op) {
    case "snapshot":
      return { pages, meta: doc.getMap("meta").toJSON(), users: doc.getMap("users").toJSON() };

    case "has":
      return !!pages[a.id];

    case "create": {
      const parentId: string | null = a.parentId ?? null;
      const parent = parentId ? entry(doc, pages, parentId, "parent page").page : null;
      if (parentId) live(pages, parentId, "parent page");
      const isRow = parent?.kind === "database";
      if (isRow) notLocked(pages, parentId!);
      if (!isRow && !canNestIn(pages, parentId)) {
        fail(`"${pageTitle(parent)}" is as deep as pages go (${MAX_DEPTH} levels), so it can't hold pages of its own. Put the page next to it instead.`);
      }
      const fields = pageFields(a.fields ?? {});
      const now = Date.now();
      if (a.id !== undefined && (!/^[a-z0-9]{12}$/.test(String(a.id)) || pages[a.id])) fail("That page id can't be used.");
      const page: Page = {
        id: a.id ?? nid(),
        title: "",
        kind: "page",
        parentId,
        order: a.after ? orderNear(pages, parentId, a.after, "after") : a.before ? orderNear(pages, parentId, a.before, "before") : nextOrder(pages, parentId),
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        ...fields,
      };
      if (isRow) page.isRow = true;
      const pendingMirrors: DbProperty[] = [];
      if (a.database) {
        const view = (a.database.view ?? "table") as ViewType;
        if (!VIEW_TYPES.includes(view)) fail(`View types: ${VIEW_TYPES.join(", ")}.`);
        let properties: DbProperty[];
        if (Array.isArray(a.database.properties)) {
          properties = [];
          const self = { ...page, kind: "database" as const, properties };
          for (const p of a.database.properties) {
            const made = newProperty(properties, p, self, pages, people);
            if (made.prop.type === "relation" && made.prop.relation?.dbId === page.id) fail("A new database can relate to itself only after it exists: add that relation with add_property.");
            properties.push(made.prop);
            if (made.twoWay && made.prop.relation) pendingMirrors.push(made.prop);
          }
        } else properties = defaultProperties(view);
        page.kind = "database";
        page.properties = properties;
        page.views = [newView(view, properties, a.database.viewName)];
      }
      if (isRow) {
        // A new row gets the next number of each ID property.
        const dbMap = yPages(doc).get(parentId!)!;
        const ids = newRowIds(pages, parent!);
        page.props = { ...(ids?.props ?? {}) };
        if (ids) {
          dbMap.set("properties", ids.properties);
          parent!.properties = ids.properties;
        }
        pages[page.id] = page;
        if (a.values !== undefined) applyValues(doc, pages, parent!, dbMap, page.id, a.values, people, page.props);
      }
      writePage(doc, page);
      // Two-way relations of a new database get their mirrors once it exists.
      if (pendingMirrors.length) {
        pages[page.id] = page;
        let list = page.properties!;
        for (const p of pendingMirrors) list = addMirror(doc, pages, page, p, list);
        yPages(doc).get(page.id)!.set("properties", list);
      }
      return { id: page.id, isRow };
    }

    case "update": {
      const { page, map } = entry(doc, pages, a.id);
      const patch = pageFields(a.patch ?? {});
      const keys = Object.keys(a.patch ?? {});
      if (keys.some((k) => k !== "locked")) notLocked({ ...pages, [a.id]: { ...page, locked: "locked" in patch ? patch.locked : page.locked } }, a.id);
      for (const [k, v] of Object.entries(patch)) (v === undefined ? map.delete(k) : map.set(k, v));
      if (keys.some((k) => ["title", "icon", "cover", "description"].includes(k))) touch(map, ctx);
      return { id: a.id };
    }

    case "touch": {
      const map = yPages(doc).get(a.id);
      if (map) touch(map, ctx);
      return null;
    }

    case "move": {
      const { page, map } = entry(doc, pages, a.id);
      const parentId: string | null = a.parentId ?? null;
      if (parentId === a.id) fail("A page can't go inside itself.");
      if (parentId) {
        entry(doc, pages, parentId, "destination");
        live(pages, parentId, "destination");
        if (descendantsOf(pages, a.id).includes(parentId)) fail("A page can't go inside one of its own sub-pages.");
      }
      if (!canMoveInto(pages, a.id, parentId)) {
        fail(`That would put pages more than ${MAX_DEPTH} levels deep, which is as deep as pages go.`);
      }
      const target = parentId ? pages[parentId] : null;
      const isRow = target?.kind === "database";
      if (isRow) notLocked(pages, parentId!);
      const sim = { ...pages, [a.id]: { ...page, parentId, isRow: isRow || undefined } };
      const order = a.after ? orderNear(sim, parentId, a.after, "after") : a.before ? orderNear(sim, parentId, a.before, "before") : nextOrder(pages, parentId);
      map.set("parentId", parentId);
      map.set("order", order);
      if (isRow) map.set("isRow", true);
      else map.delete("isRow");
      return { id: a.id, parentId, isRow };
    }

    case "trash": {
      const { page, map } = entry(doc, pages, a.id);
      if (page.trashed) return { id: a.id, alreadyTrashed: true };
      map.set("trashed", true);
      map.set("trashedAt", Date.now());
      return { id: a.id };
    }

    case "restore": {
      const { page, map } = entry(doc, pages, a.id);
      if (!page.trashed) fail(`"${pageTitle(page)}" isn't in the trash.`);
      map.delete("trashed");
      map.delete("trashedAt");
      // Its old place is gone or in the trash: back to the top level.
      if (page.parentId && isTrashed(pages, page.parentId)) {
        map.set("parentId", null);
        map.delete("isRow");
        map.set("order", nextOrder(pages, null));
        return { id: a.id, movedToTopLevel: true };
      }
      return { id: a.id };
    }

    case "purge": {
      const { page } = entry(doc, pages, a.id);
      if (!page.trashed) fail(`"${pageTitle(page)}" isn't in the trash. Move it to the trash first; deleting for good only empties the trash.`);
      const ids = [a.id, ...descendantsOf(pages, a.id)];
      for (const id of ids) yPages(doc).delete(id);
      return { ids };
    }

    case "subtree": {
      entry(doc, pages, a.id);
      return { ids: [a.id, ...descendantsOf(pages, a.id)].filter((i) => !pages[i].trashed || i === a.id) };
    }

    case "clone": {
      const map: Record<string, string> = a.map;
      const now = Date.now();
      const root = pages[a.id];
      if (!root) fail("That page no longer exists.");
      for (const [from, to] of Object.entries(map)) {
        const p = pages[from];
        if (!p) continue;
        const copy: Page = {
          ...p,
          id: to,
          title: from === a.id ? `${pageTitle(p)} (copy)` : p.title,
          parentId: from === a.id ? p.parentId : (map[p.parentId!] ?? p.parentId),
          order: from === a.id ? orderNear(pages, p.parentId, p.id, "after") : p.order,
          trashed: undefined,
          trashedAt: undefined,
          template: undefined,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        };
        writePage(doc, copy);
      }
      return { id: map[a.id] };
    }

    case "meta": {
      const meta = doc.getMap<any>("meta");
      if (a.name !== undefined) meta.set("name", a.name);
      if (a.icon !== undefined) (a.icon ? meta.set("icon", a.icon) : meta.delete("icon"));
      return null;
    }

    // ---- database rows

    case "setValues": {
      const out: string[] = [];
      for (const r of a.rows as any[]) {
        const { page, map } = entry(doc, pages, r.id, "row");
        live(pages, r.id, "row");
        const fields: Record<string, unknown> = {};
        if (r.title !== undefined) fields.title = r.title;
        if (r.icon !== undefined) fields.icon = r.icon;
        if (Object.keys(fields).length || r.values !== undefined) notLocked(pages, r.id);
        const patch = pageFields(fields);
        for (const [k, v] of Object.entries(patch)) (v === undefined ? map.delete(k) : map.set(k, v));
        if (r.values !== undefined) {
          if (!page.isRow || !page.parentId) fail(`"${pageTitle(page)}" isn't a database row, so it has no property values.`);
          const { db, map: dbMap } = database(doc, pages, page.parentId);
          let props = map.get("props");
          if (!(props instanceof Y.Map)) {
            props = new Y.Map<any>();
            map.set("props", props);
          }
          applyValues(doc, pages, db, dbMap, r.id, r.values, people, props);
        }
        touch(map, ctx);
        out.push(r.id);
      }
      return { updated: out };
    }

    // ---- database properties

    case "addProperty": {
      const { db, map } = database(doc, pages, a.dbId);
      notLocked(pages, a.dbId);
      const props = db.properties ?? [];
      const { prop, twoWay } = newProperty(props, a.property, db, pages, people);
      let list = [...props, prop];
      if (a.position !== undefined) list = moveItem(list, list.length - 1, a.position);
      if (prop.type === "unique_id") {
        const { ids, next } = backfillIds(pages, db.id, prop.id);
        prop.nextId = next;
        for (const [rowId, n] of Object.entries(ids)) {
          const m = yPages(doc).get(rowId);
          if (m) setProp(m, prop.id, n);
        }
      }
      if (twoWay && prop.relation) list = addMirror(doc, pages, db, prop, list);
      map.set("properties", list);
      return { property: list.find((p) => p.id === prop.id) };
    }

    case "duplicateProperty": {
      const { db, map } = database(doc, pages, a.dbId);
      notLocked(pages, a.dbId);
      const src = propertyOf(db, a.property, false);
      const props = db.properties ?? [];
      const copy: DbProperty = { ...src, id: nid(6), name: uniqueName(props, clean(a.name, 100) || src.name + " (copy)") };
      if (copy.relation) copy.relation = { dbId: copy.relation.dbId };
      const list = [...props];
      list.splice(props.indexOf(src) + 1, 0, copy);
      map.set("properties", list);
      if (src.type !== "unique_id") {
        for (const r of Object.values(pages)) {
          if (r.parentId !== db.id || !r.isRow || r.props?.[src.id] === undefined) continue;
          const m = yPages(doc).get(r.id);
          if (m) setProp(m, copy.id, r.props[src.id]);
        }
      }
      return { property: copy };
    }

    case "updateProperty": {
      const { db, map } = database(doc, pages, a.dbId);
      notLocked(pages, a.dbId);
      const props = db.properties ?? [];
      const old = propertyOf(db, a.property, false);
      let prop: DbProperty = { ...old };
      const p = a.patch ?? {};
      if (p.name !== undefined) {
        const name = clean(p.name, 100);
        if (!name) fail("A property needs a name.");
        if (props.some((x) => x.id !== prop.id && x.name.toLowerCase() === name.toLowerCase())) fail(`There's already a property called "${name}".`);
        prop.name = name;
      }
      // Changing type converts the values rows already have, as the app does.
      let converted: Record<string, any> = {};
      if (p.type !== undefined && p.type !== old.type) {
        if (!PROP_TYPES.includes(p.type)) fail(`Property types: ${PROP_TYPES.join(", ")}.`);
        if (old.relation?.syncedPropId) dropMirror(doc, pages, old, false);
        const conv = convertValues(db, old, p.type, dbCtx(pages, {}), nid);
        converted = conv.values;
        prop = { id: old.id, name: prop.name, type: p.type, description: old.description };
        if (conv.options) prop.options = conv.options;
        if (p.type === "status") prop.options = prop.options?.length ? prop.options.map((o) => ({ ...o, group: o.group ?? "todo" })) : statusOptions(nid);
        if ((p.type === "select" || p.type === "multi_select") && !prop.options) prop.options = [];
        if (["number", "formula", "rollup"].includes(old.type) && ["number", "formula", "rollup"].includes(p.type)) {
          prop.numberFormat = old.numberFormat;
          prop.decimals = old.decimals;
          prop.showAs = old.showAs;
        }
        if (p.type === "unique_id") {
          const { ids, next } = backfillIds(pages, db.id, prop.id);
          prop.nextId = next;
          converted = ids;
        }
      }
      const settings = propertySettings(prop, p, db, pages, people);
      prop = settings.prop;
      let removed: string[] = [];
      if (p.add_options || p.update_options || p.remove_options) {
        if (prop.type !== "select" && prop.type !== "multi_select" && prop.type !== "status") fail(`"${prop.name}" isn't a select, multi-select or status property, so it has no options.`);
        let options = newOptions(prop, p.add_options ?? []);
        for (const o of p.update_options ?? []) {
          const found = findOption({ ...prop, options }, o?.option);
          if (!found) fail(`"${prop.name}" has no option "${o?.option}".`);
          options = options.map((x) =>
            x.id === found.id
              ? {
                  ...x,
                  name: o.name !== undefined ? clean(o.name, 100) || x.name : x.name,
                  color: optionColor(o.color, x.color),
                  ...(prop.type === "status" && o.group !== undefined ? { group: statusGroup(o.group) } : {}),
                }
              : x,
          );
        }
        for (const ref of p.remove_options ?? []) {
          const found = findOption({ ...prop, options }, ref);
          if (!found) fail(`"${prop.name}" has no option "${ref}".`);
          options = options.filter((x) => x.id !== found.id);
          removed.push(found.id);
        }
        if (prop.type === "status" && !options.length) fail("A status property keeps at least one option.");
        prop.options = options;
      }
      let list = props.map((x) => (x.id === prop.id ? prop : x));
      if (p.position !== undefined) list = moveItem(list, list.findIndex((x) => x.id === prop.id), p.position);
      // Two-way on or off.
      if (prop.type === "relation" && settings.twoWay !== undefined) {
        if (settings.twoWay && !prop.relation?.syncedPropId) list = addMirror(doc, pages, { ...db, properties: list }, prop, list);
        else if (!settings.twoWay && prop.relation?.syncedPropId) {
          dropMirror(doc, pages, prop, true);
          prop.relation = { dbId: prop.relation.dbId };
          list = list.map((x) => (x.id === prop.id ? prop : x));
        }
      }
      for (const x of list) for (const k of Object.keys(x) as (keyof DbProperty)[]) if (x[k] === undefined) delete x[k];
      map.set("properties", list);
      for (const [rowId, value] of Object.entries(converted)) {
        const m = yPages(doc).get(rowId);
        if (m) setProp(m, prop.id, value);
      }
      // Rows and filters that used a removed option let go of it.
      if (removed.length) {
        const gone = new Set(removed);
        for (const row of Object.values(pages)) {
          if (row.parentId !== a.dbId || !row.isRow) continue;
          const v = row.props?.[prop.id];
          const rp = yPages(doc).get(row.id)?.get("props");
          if (!(rp instanceof Y.Map) || v === undefined) continue;
          if (Array.isArray(v)) {
            const kept = v.filter((x: string) => !gone.has(x));
            if (kept.length !== v.length) (kept.length ? rp.set(prop.id, kept) : rp.delete(prop.id));
          } else if (gone.has(v)) rp.delete(prop.id);
        }
        map.set(
          "views",
          (db.views ?? []).map((v) => ({
            ...v,
            filters: v.filters
              .map((f) => (isGroup(f) ? { ...f, filters: f.filters.filter((x) => !(x.propId === prop.id && gone.has(x.value))) } : f))
              .filter((f) => (isGroup(f) ? f.filters.length > 0 : !(f.propId === prop.id && gone.has(f.value)))),
          })),
        );
      }
      return { property: list.find((x) => x.id === prop.id) };
    }

    case "deleteProperty": {
      const { db, map } = database(doc, pages, a.dbId);
      notLocked(pages, a.dbId);
      const prop = propertyOf(db, a.property, false);
      map.set("properties", (db.properties ?? []).filter((p) => p.id !== prop.id));
      map.set("views", (db.views ?? []).map((v) => withoutProp(v, prop.id)));
      // The mirror of a two-way relation stays, as a one-way relation.
      if (prop.relation?.syncedPropId) dropMirror(doc, pages, prop, false);
      return { deleted: prop.name };
    }

    case "pressButton": {
      const { page, map } = entry(doc, pages, a.rowId, "row");
      live(pages, a.rowId, "row");
      notLocked(pages, a.rowId);
      if (!page.isRow || !page.parentId) fail(`"${pageTitle(page)}" isn't a database row.`);
      const { db } = database(doc, pages, page.parentId);
      const button = propertyOf(db, a.property, false);
      if (button.type !== "button") fail(`"${button.name}" isn't a button property.`);
      const changed: string[] = [];
      for (const act of button.button?.actions ?? []) {
        const target = allProps(db).find((p) => p.id === act.propId);
        if (!target) continue;
        let v = act.value;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          if (v.clear) v = undefined;
          else if (v.toggle) v = page.props?.[act.propId] ? undefined : true;
          else if (v.now) v = new Date(Date.now()).toISOString().slice(0, 10);
          else if (v.me) v = [ctx.userId];
        }
        if (target.id === "title") map.set("title", String(v ?? ""));
        else setProp(map, target.id, v);
        changed.push(target.name);
      }
      touch(map, ctx);
      return { pressed: button.button?.label || button.name, set: changed };
    }

    // ---- database views

    case "addView": {
      const { db, map } = database(doc, pages, a.dbId);
      notLocked(pages, a.dbId);
      const type = (a.view?.type ?? "table") as ViewType;
      if (!VIEW_TYPES.includes(type)) fail(`View types: ${VIEW_TYPES.join(", ")}.`);
      const view = viewPatch(db, newView(type, db.properties ?? [], clean(a.view?.name, 100) || undefined), { ...a.view, name: undefined, type: undefined }, people, pages);
      let list = [...(db.views ?? []), view];
      if (a.view?.position !== undefined) list = moveItem(list, list.length - 1, a.view.position);
      map.set("views", list);
      return { view };
    }

    case "updateView": {
      const { db, map } = database(doc, pages, a.dbId);
      notLocked(pages, a.dbId);
      const current = findView(db, a.view);
      const view = viewPatch(db, current, a.patch ?? {}, people, pages);
      let list = (db.views ?? []).map((v) => (v.id === current.id ? view : v));
      if (a.patch?.position !== undefined) list = moveItem(list, list.findIndex((v) => v.id === view.id), a.patch.position);
      map.set("views", list);
      return { view };
    }

    case "deleteView": {
      const { db, map } = database(doc, pages, a.dbId);
      notLocked(pages, a.dbId);
      const view = findView(db, a.view);
      if ((db.views ?? []).length <= 1) fail("A database keeps at least one view. Change this one instead.");
      map.set("views", (db.views ?? []).filter((v) => v.id !== view.id));
      return { deleted: view.name };
    }
  }
  fail(`Unknown workspace operation ${op}.`);
}
