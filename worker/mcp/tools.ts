// The MCP tools: everything a person can do to their workspaces, pages and databases in the app, for an AI acting
// as them. Each tool checks the connection (read only, or read and edit; which workspaces) and the person's own
// access, then runs inside the right document room so changes show up live for anyone with the page open.
import type { AiGrant, AuthStore, AuthUser } from "../auth";
import type { Env } from "../index";
import { roomName, searchName, WS_ID_RE } from "../rooms";
import { saveUpload, wipeWorkspace } from "../app";
import { BLOCK_GUIDE } from "./guide";
import {
  AGGREGATES,
  ancestorsOf,
  calculate,
  canGroupBy,
  childrenOf,
  COVER_PRESETS,
  DATE_FORMATS,
  dbCtx,
  DbCtx,
  FilterItem,
  FONTS,
  groupRows,
  GROUP_DATES,
  NUMBER_FORMATS,
  ROLLUP_FNS,
  WITHIN,
  RELATIVE_DAYS,
  passes,
  isTrashed,
  lockedBy,
  Page,
  Pages,
  pageTitle,
  Person,
  PROP_TYPES,
  propertyOf,
  readableFilter,
  readableProperty,
  readableValue,
  rowsOf,
  storedFilters,
  User,
  VIEW_TYPES,
  viewRows,
} from "./pages";
import { TEMPLATES } from "../../src/templates";
import { COLORS, fail, isObj, nid, OPTION_COLORS } from "./util";

type Auth = DurableObjectStub<AuthStore>;

export interface ToolCtx {
  env: Env;
  auth: Auth;
  user: AuthUser;
  grant: AiGrant;
  origin: string;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run: (ctx: ToolCtx, args: any) => Promise<unknown>;
}

// ================================================================ plumbing

interface Snapshot {
  pages: Pages;
  meta: { name?: string; icon?: string };
  users: Record<string, User>;
}

const room = (ctx: ToolCtx, ws: string, name: string) => ctx.env.DOCS.get(ctx.env.DOCS.idFromName(roomName(ws, name)));

function tree<T = any>(ctx: ToolCtx, ws: string, op: string, args: unknown = {}, people?: Person[]): Promise<T> {
  return room(ctx, ws, "workspace").run(roomName(ws, "workspace"), "tree", op, args, { userId: ctx.user.id, people }) as Promise<T>;
}
function content<T = any>(ctx: ToolCtx, ws: string, pageId: string, op: string, args: unknown = {}): Promise<T> {
  return room(ctx, ws, "page-" + pageId).run(roomName(ws, "page-" + pageId), "content", op, args, { userId: ctx.user.id }) as Promise<T>;
}
const snapshot = (ctx: ToolCtx, ws: string) => tree<Snapshot>(ctx, ws, "snapshot");

/** Workspaces this connection may reach: the person's own, narrowed by the connection's choice. */
async function reachable(ctx: ToolCtx) {
  const all = await ctx.auth.workspaces(ctx.user.id);
  return ctx.grant.workspaces ? all.filter((w) => ctx.grant.workspaces!.includes(w.id)) : all;
}

async function checkWorkspace(ctx: ToolCtx, ws: string): Promise<string> {
  if (!WS_ID_RE.test(ws)) fail(`"${ws}" isn't a workspace id. list_workspaces shows them.`);
  if (ctx.grant.workspaces && !ctx.grant.workspaces.includes(ws)) fail("This connection wasn't given access to that workspace. The person can change that in Sandpiper's Settings → AI & apps.");
  if (!(await ctx.auth.canAccess(ctx.user.id, ws))) fail("That workspace doesn't exist, or you're not in it.");
  return ws;
}

/** A page id, or a link to a page (https://…/w/<ws>/#/<page>), as {workspace, page}. */
function parseRef(ref: unknown): { ws?: string; id: string } {
  const s = String(ref ?? "").trim();
  const link = /^(?:https?:\/\/[^/]+)?(?:\/w\/([a-z0-9]{10}))?\/?#\/([A-Za-z0-9]{1,40})(?:\?p=([A-Za-z0-9]{1,40}))?/.exec(s);
  if (link) return { ws: link[1] ?? "main", id: link[3] ?? link[2] };
  if (!/^[A-Za-z0-9]{1,40}$/.test(s)) fail(`"${s.slice(0, 80)}" isn't a page id or a link to a page.`);
  return { id: s };
}

/**
 * Which workspace a call is about: the one named, the one in a page link, the one holding the page, or the only
 * one there is.
 */
async function locate(ctx: ToolCtx, a: { workspace_id?: string }, pageRef?: unknown): Promise<{ ws: string; id: string | null }> {
  const ref = pageRef !== undefined && pageRef !== null && pageRef !== "" ? parseRef(pageRef) : null;
  if (a.workspace_id) return { ws: await checkWorkspace(ctx, a.workspace_id), id: ref?.id ?? null };
  if (ref?.ws) return { ws: await checkWorkspace(ctx, ref.ws), id: ref.id };
  const list = await reachable(ctx);
  if (ref) {
    const hits = await Promise.all(list.map((w) => tree<boolean>(ctx, w.id, "has", { id: ref.id }).catch(() => false)));
    const at = hits.findIndex(Boolean);
    if (at < 0) fail(`There's no page with id "${ref.id}" in the workspaces this connection can reach.`);
    return { ws: list[at].id, id: ref.id };
  }
  if (list.length === 1) return { ws: list[0].id, id: null };
  fail(`Say which workspace (workspace_id). This connection reaches ${list.length}: ${list.map((w) => `${w.name ?? "Untitled"} (${w.id})`).join(", ")}.`);
}

async function people(ctx: ToolCtx, ws: string): Promise<Person[]> {
  const w = (await ctx.auth.workspaces(ctx.user.id)).find((x) => x.id === ws);
  return (w?.members ?? []).filter((m) => m.user).map((m) => ({ id: m.user!.id, name: m.user!.name, email: m.email }));
}

const pageUrl = (ctx: ToolCtx, ws: string, id: string) => `${ctx.origin}${ws === "main" ? "/" : `/w/${ws}/`}#/${id}`;
const iso = (t?: number) => (t ? new Date(t).toISOString() : undefined);

function kindOf(p: Page) {
  return p.isRow ? "row" : p.kind;
}

/** A page as tools describe it. */
function info(ctx: ToolCtx, ws: string, s: Snapshot, p: Page) {
  const by = (id?: string) => (id ? (s.users[id]?.name ?? id) : undefined);
  return {
    id: p.id,
    workspace_id: ws,
    title: pageTitle(p),
    kind: kindOf(p),
    icon: p.icon,
    url: pageUrl(ctx, ws, p.id),
    parent_id: p.parentId,
    path: ancestorsOf(s.pages, p.id).map(pageTitle),
    cover: p.cover,
    font: p.font && p.font !== "default" ? p.font : undefined,
    small_text: p.smallText || undefined,
    full_width: p.fullWidth || undefined,
    locked: p.locked || undefined,
    in_trash: isTrashed(s.pages, p.id) || undefined,
    created: iso(p.createdAt),
    created_by: by(p.createdBy),
    last_edited: iso(p.updatedAt),
    last_edited_by: by(p.updatedBy),
  };
}

function needPage(s: Snapshot, id: string, what = "page"): Page {
  const p = s.pages[id];
  if (!p) fail(`There's no ${what} with id "${id}" in this workspace.`);
  return p;
}
function needDb(s: Snapshot, id: string): Page {
  const p = needPage(s, id, "database");
  if (p.kind !== "database") fail(`"${pageTitle(p)}" is a page, not a database.`);
  if (isTrashed(s.pages, id)) fail(`"${pageTitle(p)}" is in the trash. Restore it first.`);
  return p;
}
/** Content can change only on a page that exists, isn't in the trash and isn't locked. */
function editable(s: Snapshot, id: string): Page {
  const p = needPage(s, id);
  if (isTrashed(s.pages, id)) fail(`"${pageTitle(p)}" is in the trash. Restore it first.`);
  const by = lockedBy(s.pages, id);
  if (by) fail(`"${pageTitle(by)}" is locked, so its content can't be changed. Unlock it first (update_page with locked: false).`);
  return p;
}

/** Fills the titles into page links and mentions ("[](page:id)" → "[Title](page:id)"), and people's names. */
function withTitles(s: Snapshot, md: string): string {
  return md
    .replace(/(@?)\[\]\((page|database):([A-Za-z0-9]+)\)/g, (_, at, kind, id) => {
      const p = s.pages[id];
      const t = p && !isTrashed(s.pages, id) ? pageTitle(p) : "Deleted page";
      return `${at}[${t.replace(/[\[\]]/g, "")}](${kind}:${id})`;
    })
    .replace(/@\[\]\(person:([A-Za-z0-9_-]+)\)/g, (_, id) => `@[${(s.users[id]?.name ?? "Someone").replace(/[\[\]]/g, "")}](person:${id})`);
}
function blocksWithTitles(s: Snapshot, blocks: any[]): any[] {
  return blocks.map((b) => {
    const out = { ...b };
    if (typeof out.content === "string") out.content = withTitles(s, out.content);
    if (out.type === "pageLink" || out.type === "database") {
      const id = out.props?.pageId ?? out.props?.databaseId;
      out.title = id && s.pages[id] && !isTrashed(s.pages, id) ? pageTitle(s.pages[id]) : "Deleted page";
    }
    if (out.children) out.children = blocksWithTitles(s, out.children);
    return out;
  });
}

async function touched(ctx: ToolCtx, ws: string, id: string) {
  await tree(ctx, ws, "touch", { id }).catch(() => {});
}

/** Content from a tool's arguments, to be parsed and checked inside the page's room; null when there's none. */
function contentSource(a: any): { markdown?: unknown; blocks?: unknown } | null {
  if (a.markdown === undefined && a.blocks === undefined) return null;
  if (a.markdown !== undefined && a.blocks !== undefined) fail("Send either markdown or blocks, not both.");
  return { markdown: a.markdown, blocks: a.blocks };
}

/**
 * Makes a page (or row) with its content. The content goes in first, so a page never appears half-made and content
 * that doesn't check out stops the page being made at all.
 */
async function createWithContent(ctx: ToolCtx, ws: string, source: object | null, args: Record<string, unknown>, ppl?: Person[]): Promise<{ id: string; isRow: boolean }> {
  const id = nid();
  if (source) await content(ctx, ws, id, "write", { mode: "replace", source });
  try {
    return await tree(ctx, ws, "create", { ...args, id }, ppl);
  } catch (err) {
    if (source) await room(ctx, ws, "page-" + id).destroy().catch(() => {});
    throw err;
  }
}

/** The context values are worked out in: formulas, rollups and relations reach other rows and people. */
const ctxOf = (s: Snapshot): DbCtx => dbCtx(s.pages, s.users);

function dbSchema(s: Snapshot, db: Page) {
  const c = ctxOf(s);
  const name = (id?: string) => (id === "title" ? "Name" : ((db.properties ?? []).find((p) => p.id === id)?.name ?? id));
  return {
    properties: [{ id: "title", name: "Name", type: "title" }, ...(db.properties ?? []).map((p) => readableProperty(p, db, s.pages, c))],
    views: (db.views ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      filters: v.filters.map((f) => readableFilter(db, f, s.users, s.pages)),
      filter_mode: v.filterOp === "or" ? "or" : undefined,
      sorts: v.sorts.map((x) => ({ property: name(x.propId), direction: x.dir })),
      group_by: v.groupBy ? name(v.groupBy) : undefined,
      group_dates_by: v.groupDate,
      hide_empty_groups: v.hideEmptyGroups || undefined,
      calculations: v.calcs ? Object.fromEntries(Object.entries(v.calcs).map(([k, fn]) => [name(k), fn])) : undefined,
      date_property: v.dateProp ? name(v.dateProp) : undefined,
      end_date_property: v.endProp ? name(v.endProp) : undefined,
      hidden_properties: v.hidden?.length ? v.hidden.map(name) : undefined,
      column_widths: v.widths ? Object.fromEntries(Object.entries(v.widths).map(([k, w]) => [name(k), w])) : undefined,
      wrap: v.wrap || undefined,
      wrap_columns: v.wrapCols?.length ? v.wrapCols.map(name) : undefined,
      freeze_columns: v.freeze || undefined,
      open_pages_in: v.openIn === "center" ? "center_peek" : v.openIn === "full" ? "full_page" : undefined,
      show_page_icons: v.showIcons === false ? false : undefined,
      card_preview: v.cardPreview ? (v.cardPreview === "cover" ? "page_cover" : v.cardPreview === "none" ? "none" : name(v.cardPreview)) : undefined,
      card_size: v.cardSize,
      week_starts_on: v.weekStart === 1 ? "monday" : undefined,
      show_weekends: v.showWeekends === false ? false : undefined,
      timeline_zoom: v.timelineScale,
      chart: v.chart
        ? {
            type: v.chart.type,
            group_by: v.chart.x ? name(v.chart.x) : undefined,
            value: v.chart.y?.fn && v.chart.y.fn !== "count" ? `${v.chart.y.fn} of ${name(v.chart.y.propId)}` : "count",
            split_by: v.chart.stack ? name(v.chart.stack) : undefined,
          }
        : undefined,
    })),
    row_count: rowsOf(s.pages, db.id).length,
  };
}

function rowValues(s: Snapshot, db: Page, row: Page, c: DbCtx = ctxOf(s)) {
  const out: Record<string, unknown> = {};
  for (const p of db.properties ?? []) if (p.type !== "button") out[p.name] = readableValue(row, p, c);
  return out;
}

const position = (a: any) => ({ after: a.after_page_id || undefined, before: a.before_page_id || undefined });
const blockPosition = (a: any) => ({
  after: a.after_block_id || undefined,
  before: a.before_block_id || undefined,
  parent: a.parent_block_id || undefined,
  index: a.index ?? undefined,
  at: a.at === "start" ? "start" : undefined,
});

const pageFieldsFrom = (a: any) => {
  const f: Record<string, unknown> = {};
  if (a.title !== undefined) f.title = a.title;
  if (a.icon !== undefined) f.icon = a.icon;
  if (a.cover !== undefined) f.cover = a.cover;
  if (a.font !== undefined) f.font = a.font;
  if (a.small_text !== undefined) f.smallText = a.small_text;
  if (a.full_width !== undefined) f.fullWidth = a.full_width;
  if (a.locked !== undefined) f.locked = a.locked;
  return f;
};

// ================================================================ schemas

const S = {
  ws: { type: "string", description: "Workspace id (from list_workspaces). Optional when page_id is given or only one workspace is reachable." },
  page: { type: "string", description: "Page id, or a link to the page." },
  str: (description: string) => ({ type: "string", description }),
  bool: (description: string) => ({ type: "boolean", description }),
  int: (description: string) => ({ type: "integer", description }),
  arr: (items: Record<string, unknown>, description: string) => ({ type: "array", items, description }),
  markdown: {
    type: "string",
    description:
      'Content as Markdown. Extras: <u>underline</u>, <span style="color:red">coloured text</span>, <mark>highlight</mark> or <mark style="background:blue">…</mark>, "- [ ] to-do", "> [!💡] callout", <details><summary>Toggle</summary>…</details>, "[Title](page:<id>)" alone on a line = link to a page, "[Title](database:<id>)" = a database shown inline, "@[Title](page:<id>)" = mention, "@[Name](person:<userId>)" = person, "@date(2026-12-01)" = date, "$x^2$" = equation, "$$…$$" on its own lines = block equation, ```mermaid / plantuml / graphviz = diagram, ":::columns / :::column / :::" = side-by-side columns, "[toc]", "[breadcrumb]", "[bookmark](https://…)", "[embed](https://…)" alone on a line, "<details><summary>## Title</summary>…</details>" = toggle heading, "####" = heading 4. Colours: ' +
      COLORS.join(", ") +
      ".",
  },
  blocks: {
    type: "array",
    items: { type: "object" },
    description:
      'Content as blocks (full control): [{"type": "heading", "props": {"level": 2, "textColor": "blue", "textAlignment": "center"}, "content": "Text with **inline Markdown**", "children": [...]}]. Types and props: see the instructions, or blocks returned by get_page with format "blocks". Text in "content" is inline Markdown (code blocks: plain text). Tables: {"type": "table", "content": {"rows": [["a", "b"], ["c", "d"]], "headerRows": 1}}.',
  },
  color: { type: "string", enum: [...COLORS] },
  optionColor: { type: "string", enum: [...OPTION_COLORS] },
  styles: {
    bold: { type: "boolean" },
    italic: { type: "boolean" },
    underline: { type: "boolean" },
    strike: { type: "boolean", description: "Strikethrough." },
    code: { type: "boolean", description: "Inline code." },
    text_color: { type: "string", enum: [...COLORS], description: '"default" removes the colour.' },
    highlight: { type: "string", enum: [...COLORS], description: 'Background highlight; "default" removes it.' },
    link: { type: ["string", "null"], description: "Make it a link (https://…); null or empty removes the link." },
  },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const pageSettings = {
  title: S.str("Page title."),
  icon: S.str('An emoji, like "📚". Empty removes it.'),
  cover: S.str(`Cover: ${COVER_PRESETS.join(", ")} (g: gradients, c: plain colours), an image address (https://…) or an uploaded file (/uploads/…). Empty removes it.`),
  font: { type: "string", enum: [...FONTS], description: "The page's font." },
  small_text: S.bool("Smaller text on the page."),
  full_width: S.bool("Use the full width of the window."),
  locked: S.bool("Locked pages can't be edited (in the app or here) until unlocked."),
};
const blockPos = {
  after_block_id: S.str("Insert after this block."),
  before_block_id: S.str("Insert before this block."),
  parent_block_id: S.str("Insert inside this block, as nested blocks (at index, default the end)."),
  index: S.int("Position among the parent's nested blocks, or on the page when no block is named (0 = first)."),
  at: { type: "string", enum: ["start", "end"], description: "Start or end of the page (default end) when no block is named." },
};
const filterItem = {
  type: "object",
  description: "A filter {property, op, value}, or a group {any_of: [filters]} / {all_of: [filters]}.",
};
const viewSettings = {
  name: S.str("View name."),
  filters: S.arr(
    filterItem,
    "Which rows show. Ops — text/url/email/phone/title: contains, not_contains, is, is_not, starts_with, ends_with; number/ID: eq, neq, gt, lt, gte, lte; select/status: is, is_not (status also takes a group: todo, in_progress, done); multi-select/person/relation: contains, not_contains; checkbox: checked, unchecked; dates: is, before, after, on_or_before, on_or_after (YYYY-MM-DD or " +
      RELATIVE_DAYS.map((r) => r.id).join("/") +
      "), within (" +
      WITHIN.map((w) => w.id).join("/") +
      '); any: empty, not_empty. Formulas and rollups use the ops of what they give. A group: {"any_of": [{…}, {…}]} matches if any filter in it does. [] clears.',
  ),
  filter_mode: { type: "string", enum: ["and", "or"], description: "How the top-level filters combine (default and: every filter)." },
  sorts: S.arr(obj({ property: S.str("Property name."), direction: { type: "string", enum: ["asc", "desc"] } }, ["property"]), "Sort order, first sort first. [] clears."),
  group_by: {
    type: ["string", "null"],
    description: "Group rows by a property (board columns; sections in table, list and gallery): select, status, multi-select, person, checkbox, dates, text, number, relation, formula. null ungroups (boards always group).",
  },
  group_dates_by: { type: "string", enum: GROUP_DATES.map((g) => g.id), description: "When grouping by a date." },
  hide_empty_groups: S.bool("Hide groups with no rows."),
  hidden_groups: S.arr({ type: "string" }, 'Groups not shown, by name ("No <property>" for the empty group).'),
  color_columns: S.bool("Boards: tint columns with their option colour."),
  calculations: {
    type: "object",
    additionalProperties: { type: ["string", "null"] },
    description: 'Column calculations by property name, like {"Estimate": "sum", "Name": "count_all"}; null removes one. Functions: ' + AGGREGATES.map((x) => x.fn).join(", ") + ".",
  },
  date_property: { type: ["string", "null"], description: "Calendar and timeline views: the date property that places rows." },
  end_date_property: { type: ["string", "null"], description: "Timeline: a separate date property where bars end (otherwise a date's own end)." },
  timeline_zoom: { type: "string", enum: ["day", "week", "month", "quarter", "year"] },
  show_table: S.bool("Timeline: show the table of names beside the bars."),
  hidden_properties: S.arr({ type: "string" }, "Properties not shown in this view."),
  column_widths: { type: "object", additionalProperties: { type: "number" }, description: 'Table column widths in pixels, by property name: {"Name": 280}.' },
  wrap: S.bool("Wrap long text in every table cell."),
  wrap_columns: S.arr({ type: "string" }, "Wrap text in just these columns."),
  freeze_columns: S.int("Table: how many columns from the left stay put while scrolling sideways (0 = none)."),
  open_pages_in: { type: "string", enum: ["side_peek", "center_peek", "full_page"], description: "How a row opens when clicked." },
  show_page_icons: S.bool("Show rows' page icons."),
  card_preview: S.str('Boards and galleries: "none", "page_cover", or a Files & media property whose first image shows.'),
  card_size: { type: "string", enum: ["small", "medium", "large"] },
  fit_image: S.bool("Show the whole preview image instead of filling the card."),
  week_starts_on: { type: "string", enum: ["sunday", "monday"], description: "Calendar." },
  show_weekends: S.bool("Calendar."),
  chart: obj({
    type: { type: "string", enum: ["bar", "hbar", "line", "donut"], description: "bar: vertical bars; hbar: horizontal bars." },
    group_by: S.str("The property whose groups are the bars, points or slices."),
    value: S.str('"count" (rows), or like "sum of Estimate" (sum, average, median, min, max of a number property).'),
    split_by: { type: ["string", "null"], description: "Bars only: stack each bar by a second property." },
    sort: { type: "string", enum: ["group", "value"], description: "value: largest first." },
    hide_empty: S.bool("Leave out groups with nothing in them."),
    show_values: S.bool("Write the values on the chart."),
  }),
  position: S.int("Where the view goes among the database's views (0 = first)."),
};
const propertySettings = {
  description: S.str("A short note on what the property is for (shown on hover)."),
  options: S.arr(
    { anyOf: [{ type: "string" }, obj({ name: { type: "string" }, color: S.optionColor, group: { type: "string", enum: ["todo", "in_progress", "done"], description: "Status only." } }, ["name"])] },
    "Options of a select, multi-select or status property.",
  ),
  number_format: { type: "string", enum: NUMBER_FORMATS.map((x) => x.id), description: "Numbers, formulas and rollups: number, comma (with separators), percent (0.5 shows 50%), or a currency code." },
  decimals: { type: ["integer", "null"], description: "Decimal places, 0 to 8 (null = default)." },
  show_as: { type: "string", enum: ["number", "bar", "ring"], description: "Show a number as a progress bar or ring." },
  bar_color: S.optionColor,
  divide_by: { type: "number", description: "The value of a full bar or ring (default 100, or 1 for percent)." },
  show_number: S.bool("Show the number beside its bar or ring (default true)."),
  date_format: { type: "string", enum: DATE_FORMATS.map((x) => x.id), description: "How dates show." },
  time_format: { type: "string", enum: ["12h", "24h"] },
  related_database: S.str("Relation: the database (id, link or title) whose rows this property links to."),
  two_way: S.bool("Relation: also show it on the related database, kept in step (default true for new relations)."),
  rollup: obj({
    relation_property: S.str("A Relation property of this database."),
    rollup_property: S.str('The property of the related rows to sum up (or "Name").'),
    calculate: { type: "string", enum: ROLLUP_FNS.map((x) => x.fn) },
  }),
  expression: S.str(
    'Formula, Notion-style: prop("Price") * prop("Qty"), if(prop("Done"), "✅", "⏳"), dateBetween(prop("Due"), now(), "days"), prop("Tags").length(), format(), concat(), round(x, 2), and more.',
  ),
  prefix: S.str("ID: text before each number, like TASK (TASK-1, TASK-2…)."),
  button: obj({
    label: S.str("Text on the button."),
    actions: S.arr(
      obj({ property: S.str("Property to set."), value: { description: 'Value as in update_rows; also "toggle" (checkbox), "now" (date), "me" (person), "clear".' } }, ["property"]),
      "What pressing it sets on its row.",
    ),
  }),
};
const propertyDef = obj({ name: S.str("Property name."), type: { type: "string", enum: PROP_TYPES }, ...propertySettings }, ["name", "type"]);
const valuesSchema = {
  type: "object",
  description:
    'Property values by property name: text/url/email/phone: string; number; checkbox: true/false; date: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM", or {"start": …, "end": …} for a range; select/status: option name; multi-select: list of option names (new names become options; status options must exist); person: list of names or emails; files: list of https:// or /uploads/ addresses (or {name, url}); relation: list of row ids or titles in the related database. Formulas, rollups, IDs, buttons and created/edited properties are worked out by Sandpiper. null clears a value.',
};

// ================================================================ tools

const t = (def: Omit<Tool, "inputSchema"> & { inputSchema: Record<string, unknown> }): Tool => def;

export const TOOLS: Tool[] = [
  // ---------------------------------------------------------------- account & workspaces
  t({
    name: "whoami",
    title: "Who am I",
    description: "Who this connection acts as, what it may do (read only, or read and edit) and which workspaces it reaches.",
    inputSchema: obj({}),
    write: false,
    run: async (ctx) => {
      const list = await reachable(ctx);
      return {
        user: { name: ctx.user.name, email: ctx.user.email },
        access: ctx.grant.access === "write" ? "read and edit" : "read only",
        workspaces_scope: ctx.grant.workspaces ? "only some workspaces" : "all of this person's workspaces",
        workspaces: list.map((w) => ({ id: w.id, name: w.name ?? "Untitled workspace", icon: w.icon })),
      };
    },
  }),
  t({
    name: "list_workspaces",
    title: "List workspaces",
    description: "The workspaces this connection reaches, with who's in each and who manages it.",
    inputSchema: obj({}),
    write: false,
    run: async (ctx) => ({
      workspaces: (await reachable(ctx)).map((w) => ({
        id: w.id,
        name: w.name ?? "Untitled workspace",
        icon: w.icon,
        url: `${ctx.origin}${w.id === "main" ? "/" : `/w/${w.id}/`}`,
        you_manage_it: w.isOwner,
        manager: w.owner,
        members: w.members.map((m) => ({ name: m.user?.name ?? null, email: m.email })),
      })),
    }),
  }),
  t({
    name: "list_people",
    title: "List people",
    description: "Everyone who can sign in to Sandpiper (names and emails), i.e. who can be added to a workspace.",
    inputSchema: obj({}),
    write: false,
    run: async (ctx) => ({ people: (await ctx.auth.members(ctx.user.id)).map((m) => ({ name: m.user?.name ?? null, email: m.email, role: m.role })) }),
  }),
  t({
    name: "create_workspace",
    title: "Create workspace",
    description: "Creates a workspace managed by this person. Leave member_emails empty for a private one; otherwise list who else is in it (people from list_people).",
    inputSchema: obj({ name: S.str("Workspace name."), icon: S.str("An emoji."), member_emails: S.arr({ type: "string" }, "Emails of other people to include.") }, ["name"]),
    write: true,
    run: async (ctx, a) => {
      const w = await ctx.auth.createWorkspace(ctx.user.id, { name: a.name, icon: a.icon, members: a.member_emails ?? [] });
      await ctx.auth.aiGrantAddWorkspace(ctx.grant.id, w.id);
      await tree(ctx, w.id, "meta", { name: w.name, icon: w.icon ?? "" });
      return { workspace: { id: w.id, name: w.name, icon: w.icon, url: `${ctx.origin}/w/${w.id}/`, members: w.members.map((m) => m.email) } };
    },
  }),
  t({
    name: "update_workspace",
    title: "Rename workspace",
    description: "Changes a workspace's name or icon (anyone in it can).",
    inputSchema: obj({ workspace_id: S.ws, name: S.str("New name."), icon: S.str("An emoji; empty removes it.") }, ["workspace_id"]),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const ws = await checkWorkspace(ctx, a.workspace_id);
      const w = await ctx.auth.updateWorkspace(ctx.user.id, ws, { name: a.name, icon: a.icon });
      await tree(ctx, ws, "meta", { name: a.name !== undefined ? w.name : undefined, icon: a.icon !== undefined ? (w.icon ?? "") : undefined });
      return { workspace: { id: w.id, name: w.name, icon: w.icon } };
    },
  }),
  t({
    name: "set_workspace_members",
    title: "Set workspace members",
    description: "Sets exactly who is in a workspace (only the person who manages it can). Anyone left out loses access straight away.",
    inputSchema: obj({ workspace_id: S.ws, member_emails: S.arr({ type: "string" }, "Everyone who should be in it besides the manager.") }, ["workspace_id", "member_emails"]),
    write: true,
    destructive: true,
    idempotent: true,
    run: async (ctx, a) => {
      const ws = await checkWorkspace(ctx, a.workspace_id);
      const w = await ctx.auth.setWorkspaceMembers(ctx.user.id, ws, a.member_emails);
      return { workspace: { id: w.id, members: w.members.map((m) => m.email) } };
    },
  }),
  t({
    name: "leave_workspace",
    title: "Leave workspace",
    description: "Takes this person out of a workspace they don't manage. They lose access to it.",
    inputSchema: obj({ workspace_id: S.ws }, ["workspace_id"]),
    write: true,
    destructive: true,
    run: async (ctx, a) => {
      const ws = await checkWorkspace(ctx, a.workspace_id);
      await ctx.auth.leaveWorkspace(ctx.user.id, ws);
      return { left: ws };
    },
  }),
  t({
    name: "delete_workspace",
    title: "Delete workspace",
    description: "Deletes a workspace and everything in it, for everyone. Can't be undone. Only its manager can. Confirm with the person first.",
    inputSchema: obj({ workspace_id: S.ws, confirm_name: S.str("The workspace's exact name, to confirm.") }, ["workspace_id", "confirm_name"]),
    write: true,
    destructive: true,
    run: async (ctx, a) => {
      const ws = await checkWorkspace(ctx, a.workspace_id);
      const w = (await ctx.auth.workspaces(ctx.user.id)).find((x) => x.id === ws);
      if ((w?.name ?? "") !== String(a.confirm_name ?? "")) fail(`confirm_name must be the workspace's exact name ("${w?.name ?? ""}").`);
      await ctx.auth.deleteWorkspace(ctx.user.id, ws);
      await wipeWorkspace(ctx.env, ws);
      return { deleted: ws };
    },
  }),
  t({
    name: "update_profile",
    title: "Update profile",
    description: "Changes this person's display name or cursor colour.",
    inputSchema: obj({ name: S.str("Display name."), color: S.str("Cursor colour as #rrggbb.") }),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const u = await ctx.auth.updateProfile(ctx.user.id, { name: a.name, color: a.color });
      return { user: { name: u?.name, color: u?.color } };
    },
  }),

  // ---------------------------------------------------------------- pages
  t({
    name: "list_pages",
    title: "List pages",
    description: "The page tree of a workspace (pages and databases, nested as in the sidebar). Database rows are left out unless asked for.",
    inputSchema: obj({
      workspace_id: S.ws,
      parent_id: S.str("Only what's inside this page."),
      depth: S.int("How many levels to show (default all)."),
      include_rows: S.bool("Also list database rows (up to 50 per database)."),
    }),
    write: false,
    run: async (ctx, a) => {
      const { ws } = await locate(ctx, a);
      const s = await snapshot(ctx, ws);
      let count = 0;
      const depth = a.depth ? Math.max(1, Number(a.depth)) : 99;
      const node = (p: Page, level: number): any => {
        count++;
        const kids = level < depth ? childrenOf(s.pages, p.id) : [];
        const rows = p.kind === "database" ? rowsOf(s.pages, p.id) : [];
        return {
          id: p.id,
          title: pageTitle(p),
          ...(p.icon ? { icon: p.icon } : {}),
          ...(p.kind === "database" ? { kind: "database", rows: rows.length } : {}),
          ...(p.locked ? { locked: true } : {}),
          ...(kids.length && count < 2000 ? { children: kids.map((k) => node(k, level + 1)) } : childrenOf(s.pages, p.id).length ? { has_children: true } : {}),
          ...(a.include_rows && rows.length ? { row_list: rows.slice(0, 50).map((r) => ({ id: r.id, title: pageTitle(r) })) } : {}),
        };
      };
      if (a.parent_id) needPage(s, parseRef(a.parent_id).id);
      const top = childrenOf(s.pages, a.parent_id ? parseRef(a.parent_id).id : null);
      return { workspace_id: ws, workspace: s.meta.name, pages: top.map((p) => node(p, 1)) };
    },
  }),
  t({
    name: "search",
    title: "Search",
    description: "Finds pages, databases and rows by title and by the text in them. Searches every reachable workspace unless one is named.",
    inputSchema: obj({ query: S.str("Words to look for."), workspace_id: S.ws, limit: S.int("Most results (default 20).") }, ["query"]),
    write: false,
    run: async (ctx, a) => {
      const q = String(a.query ?? "").trim();
      if (q.length < 2) fail("Search for at least two characters.");
      const spaces = a.workspace_id ? [{ id: await checkWorkspace(ctx, a.workspace_id) }] : await reachable(ctx);
      const limit = Math.min(100, Math.max(1, Number(a.limit ?? 20)));
      const results: any[] = [];
      for (const w of spaces) {
        const s = await snapshot(ctx, w.id);
        const lower = q.toLowerCase();
        const seen = new Set<string>();
        for (const p of Object.values(s.pages)) {
          if (isTrashed(s.pages, p.id) || !pageTitle(p).toLowerCase().includes(lower)) continue;
          seen.add(p.id);
          results.push({ workspace_id: w.id, id: p.id, title: pageTitle(p), kind: kindOf(p), path: ancestorsOf(s.pages, p.id).map(pageTitle), match: "title" });
        }
        const hits = await ctx.env.SEARCH.get(ctx.env.SEARCH.idFromName(searchName(w.id))).search(q);
        for (const h of hits) {
          const p = s.pages[h.pageId];
          if (!p || isTrashed(s.pages, p.id) || seen.has(p.id)) continue;
          results.push({ workspace_id: w.id, id: p.id, title: pageTitle(p), kind: kindOf(p), path: ancestorsOf(s.pages, p.id).map(pageTitle), match: "text", snippet: h.snippet });
        }
      }
      return { results: results.slice(0, limit), more: results.length > limit || undefined };
    },
  }),
  t({
    name: "get_page",
    title: "Read page",
    description:
      'Reads a page, database or row: its settings, its content (Markdown by default; format "blocks" gives every block with its id, props and colours, for precise edits), sub-pages, and for databases their properties and views, for rows their property values.',
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, format: { type: "string", enum: ["markdown", "blocks", "none"], description: "Content as markdown (default), blocks, or none." } }, ["page_id"]),
    write: false,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      const s = await snapshot(ctx, ws);
      const p = needPage(s, id!);
      const out: any = { page: info(ctx, ws, s, p) };
      const kids = childrenOf(s.pages, p.id);
      if (kids.length) out.sub_pages = kids.map((k) => ({ id: k.id, title: pageTitle(k), kind: k.kind, ...(k.icon ? { icon: k.icon } : {}) }));
      if (p.kind === "database") out.database = dbSchema(s, p);
      if (p.isRow && p.parentId && s.pages[p.parentId]) {
        const db = s.pages[p.parentId];
        out.database = { id: db.id, title: pageTitle(db) };
        out.values = rowValues(s, db, p);
      }
      if (a.format !== "none") {
        const c = await content(ctx, ws, p.id, "read", { format: a.format === "blocks" ? "blocks" : "markdown" });
        if (c.blocks) out.blocks = blocksWithTitles(s, c.blocks);
        else out.markdown = withTitles(s, c.markdown ?? "");
        if (c.openComments) out.open_comments = c.openComments;
      }
      return out;
    },
  }),
  t({
    name: "create_page",
    title: "Create page",
    description:
      "Creates a page: at the top level, inside another page (nested, up to 8 levels), or as a row when the parent is a database (then set values too). Content can be Markdown or blocks, or a template.",
    inputSchema: obj(
      {
        workspace_id: S.ws,
        parent_id: S.str("The page (or database) it goes in. Leave out for the top level."),
        ...pageSettings,
        markdown: S.markdown,
        blocks: S.blocks,
        template: { type: "string", enum: Object.keys(TEMPLATES), description: "Start from a template instead of content." },
        values: valuesSchema,
        after_page_id: S.str("Place it right after this sibling page."),
        before_page_id: S.str("Place it right before this sibling page."),
        link_in_parent: S.bool("Also add a link to the new page at the end of the parent page's content."),
      },
      ["title"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws } = await locate(ctx, a, a.parent_id);
      const parentId = a.parent_id ? parseRef(a.parent_id).id : null;
      if (a.template && !TEMPLATES[a.template]) fail(`Templates: ${Object.keys(TEMPLATES).join(", ")}.`);
      const source = a.template ? { raw: TEMPLATES[a.template].blocks } : contentSource(a);
      const s = parentId ? await snapshot(ctx, ws) : null;
      if (a.values !== undefined && (!s || s.pages[parentId!]?.kind !== "database")) fail("values are for rows: create the page inside a database (parent_id).");
      const link = !!(a.link_in_parent && parentId && s?.pages[parentId]?.kind === "page");
      if (link) editable(s!, parentId!);
      const id = await createWithContent(ctx, ws, source, { parentId, fields: pageFieldsFrom(a), values: a.values, ...position(a) }, a.values ? await people(ctx, ws) : undefined);
      if (link) {
        await content(ctx, ws, parentId!, "write", { mode: "append", source: { raw: [{ type: "pageLink", props: { pageId: id.id } }] } });
        await touched(ctx, ws, parentId!);
      }
      return { id: id.id, workspace_id: ws, url: pageUrl(ctx, ws, id.id), kind: id.isRow ? "row" : "page" };
    },
  }),
  t({
    name: "update_page",
    title: "Update page settings",
    description: "Changes a page's (or database's or row's) title, icon, cover, font, small text, full width, or locks/unlocks it.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, ...pageSettings }, ["page_id"]),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      const fields = pageFieldsFrom(a);
      if (!Object.keys(fields).length) fail("Say what to change (title, icon, cover, font, small_text, full_width, locked).");
      await tree(ctx, ws, "update", { id, patch: fields });
      const s = await snapshot(ctx, ws);
      return { page: info(ctx, ws, s, s.pages[id!]) };
    },
  }),
  t({
    name: "move_page",
    title: "Move page",
    description: "Moves a page (with everything inside it) to another parent page, into a database (it becomes a row), or to the top level; or reorders it among its siblings.",
    inputSchema: obj(
      {
        page_id: S.page,
        workspace_id: S.ws,
        parent_id: { type: ["string", "null"], description: "New parent page or database; null for the top level. Leave out to keep the parent and only reorder." },
        after_page_id: S.str("Place it right after this sibling."),
        before_page_id: S.str("Place it right before this sibling."),
      },
      ["page_id"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      const s = await snapshot(ctx, ws);
      const p = needPage(s, id!);
      const parentId = a.parent_id === undefined ? p.parentId : a.parent_id === null || a.parent_id === "" ? null : parseRef(a.parent_id).id;
      const r = await tree(ctx, ws, "move", { id, parentId, ...position(a) });
      return { id, parent_id: r.parentId, kind: r.isRow ? "row" : p.kind };
    },
  }),
  t({
    name: "duplicate_page",
    title: "Duplicate page",
    description: "Copies a page with its content and everything inside it; the copy goes right after it.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws }, ["page_id"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      const { ids } = await tree(ctx, ws, "subtree", { id });
      const map: Record<string, string> = Object.fromEntries(ids.map((i: string) => [i, nid()]));
      // Content first, so nobody opens a copy before its content is there.
      for (let i = 0; i < ids.length; i += 10) {
        await Promise.all(
          ids.slice(i, i + 10).map(async (from: string) => {
            const state = await room(ctx, ws, "page-" + from).getState();
            await room(ctx, ws, "page-" + map[from]).putState(roomName(ws, "page-" + map[from]), state);
          }),
        );
      }
      const r = await tree(ctx, ws, "clone", { id, map });
      return { id: r.id, url: pageUrl(ctx, ws, r.id), copied_pages: ids.length };
    },
  }),
  t({
    name: "trash_page",
    title: "Move to trash",
    description: "Moves pages, databases or rows to the trash (with everything inside them). They can be restored.",
    inputSchema: obj({ page_id: S.page, page_ids: S.arr({ type: "string" }, "Several pages at once (all in one workspace)."), workspace_id: S.ws }),
    write: true,
    run: async (ctx, a) => {
      const list: string[] = a.page_ids?.length ? a.page_ids : a.page_id ? [a.page_id] : fail("Say which page (page_id or page_ids).");
      const { ws } = await locate(ctx, a, list[0]);
      for (const ref of list) await tree(ctx, ws, "trash", { id: parseRef(ref).id });
      return { trashed: list.map((r) => parseRef(r).id) };
    },
  }),
  t({
    name: "restore_page",
    title: "Restore from trash",
    description: "Brings a page back from the trash, to where it was (or the top level if that's gone).",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws }, ["page_id"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      return tree(ctx, ws, "restore", { id });
    },
  }),
  t({
    name: "list_trash",
    title: "List trash",
    description: "What's in a workspace's trash.",
    inputSchema: obj({ workspace_id: S.ws }),
    write: false,
    run: async (ctx, a) => {
      const { ws } = await locate(ctx, a);
      const s = await snapshot(ctx, ws);
      return {
        trash: Object.values(s.pages)
          .filter((p) => p.trashed)
          .sort((x, y) => (y.trashedAt ?? 0) - (x.trashedAt ?? 0))
          .map((p) => ({ id: p.id, title: pageTitle(p), kind: kindOf(p), trashed: iso(p.trashedAt) })),
      };
    },
  }),
  t({
    name: "delete_page_forever",
    title: "Delete forever",
    description: "Permanently deletes a page that is already in the trash, with everything inside it. Can't be undone. Confirm with the person first.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws }, ["page_id"]),
    write: true,
    destructive: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      const { ids } = await tree(ctx, ws, "purge", { id });
      const search = ctx.env.SEARCH.get(ctx.env.SEARCH.idFromName(searchName(ws)));
      for (const pid of ids as string[]) {
        await room(ctx, ws, "page-" + pid).destroy().catch(() => {});
        await search.remove(pid).catch(() => {});
      }
      return { deleted: ids.length };
    },
  }),

  // ---------------------------------------------------------------- page content
  t({
    name: "write_page_content",
    title: "Write page content",
    description: 'Adds content to a page (at the end by default, or the start), or replaces all of it (mode "replace"). Markdown or blocks.',
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, markdown: S.markdown, blocks: S.blocks, mode: { type: "string", enum: ["append", "prepend", "replace"], description: "Default append." } }, ["page_id"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      const source = contentSource(a) ?? fail("Send the content as markdown (a string) or blocks (a list).");
      const mode = a.mode === "replace" || a.mode === "prepend" ? a.mode : "append";
      const r = await content(ctx, ws, id!, "write", { mode, source });
      await touched(ctx, ws, id!);
      return { page_id: id, mode, block_ids: r.blockIds };
    },
  }),
  t({
    name: "insert_blocks",
    title: "Insert blocks",
    description: "Inserts content at an exact place: after or before a block, or nested inside one. Block ids come from get_page with format \"blocks\".",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, markdown: S.markdown, blocks: S.blocks, ...blockPos }, ["page_id"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      const source = contentSource(a) ?? fail("Send the content as markdown (a string) or blocks (a list).");
      const r = await content(ctx, ws, id!, "insert", { source, position: blockPosition(a) });
      await touched(ctx, ws, id!);
      return { page_id: id, block_ids: r.blockIds };
    },
  }),
  t({
    name: "update_block",
    title: "Update block",
    description:
      'Changes one block: its type (e.g. paragraph → heading), props (heading level, text/background colour, alignment, checked, code language, callout emoji, image url/caption/width…), its text (inline Markdown) or its nested blocks. Props alone keep the text and comments exactly as they are.',
    inputSchema: obj(
      {
        page_id: S.page,
        workspace_id: S.ws,
        block_id: S.str("The block's id."),
        type: S.str("New block type."),
        props: { type: "object", description: 'Props to set, e.g. {"level": 2}, {"backgroundColor": "yellow"}, {"textAlignment": "center"}, {"checked": true}.' },
        content: { description: "New text (inline Markdown), or table content {rows: [[…]]}, or code." },
        children: S.blocks,
      },
      ["page_id", "block_id"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      const r = await content(ctx, ws, id!, "update", { blockId: a.block_id, type: a.type, props: a.props, content: a.content, children: a.children });
      await touched(ctx, ws, id!);
      return r;
    },
  }),
  t({
    name: "delete_blocks",
    title: "Delete blocks",
    description: "Deletes blocks (and the blocks nested inside them) from a page.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, block_ids: S.arr({ type: "string" }, "Ids of the blocks to delete.") }, ["page_id", "block_ids"]),
    write: true,
    destructive: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      if (!Array.isArray(a.block_ids) || !a.block_ids.length) fail("Say which blocks (block_ids).");
      const r = await content(ctx, ws, id!, "delete", { blockIds: a.block_ids.map(String) });
      await touched(ctx, ws, id!);
      return r;
    },
  }),
  t({
    name: "move_block",
    title: "Move block",
    description: "Moves a block (with its nested blocks) to another place on the same page: after/before another block, inside one, or to the start or end.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, block_id: S.str("The block to move."), ...blockPos }, ["page_id", "block_id"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      const r = await content(ctx, ws, id!, "move", { blockId: a.block_id, position: blockPosition(a) });
      await touched(ctx, ws, id!);
      return r;
    },
  }),
  t({
    name: "format_text",
    title: "Format text",
    description:
      "Styles text on a page without retyping it: bold, italic, underline, strikethrough, inline code, text colour, highlight, link. Finds the exact text (every occurrence by default), or formats a whole block. false/\"default\" removes a style.",
    inputSchema: obj(
      {
        page_id: S.page,
        workspace_id: S.ws,
        text: S.str("The exact text to style."),
        block_id: S.str("Only in this block (or, without text, the whole block)."),
        occurrence: { description: '"all" (default), "first", "last", or a number from 1.' },
        match_case: S.bool("Default true."),
        ...S.styles,
      },
      ["page_id"],
    ),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      const styles = {
        bold: a.bold,
        italic: a.italic,
        underline: a.underline,
        strike: a.strike,
        code: a.code,
        textColor: a.text_color,
        backgroundColor: a.highlight,
        link: a.link === undefined ? undefined : a.link || null,
      };
      const r = await content(ctx, ws, id!, "formatText", { text: a.text, blockId: a.block_id, occurrence: a.occurrence, matchCase: a.match_case, styles });
      await touched(ctx, ws, id!);
      return r;
    },
  }),
  t({
    name: "replace_text",
    title: "Find and replace",
    description: "Replaces text on a page, keeping its formatting (every occurrence by default).",
    inputSchema: obj(
      {
        page_id: S.page,
        workspace_id: S.ws,
        find: S.str("Exact text to find."),
        replace: S.str("What to put instead (empty deletes it)."),
        block_id: S.str("Only in this block."),
        all: S.bool("Replace every occurrence (default true) or only the first."),
        match_case: S.bool("Default true."),
      },
      ["page_id", "find", "replace"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      const r = await content(ctx, ws, id!, "replaceText", { find: a.find, replace: a.replace ?? "", blockId: a.block_id, all: a.all, matchCase: a.match_case });
      await touched(ctx, ws, id!);
      return r;
    },
  }),
  t({
    name: "insert_text",
    title: "Insert text",
    description: "Adds text to an existing block (at its start, end, or right after some text in it), optionally styled.",
    inputSchema: obj(
      {
        page_id: S.page,
        workspace_id: S.ws,
        block_id: S.str("The block."),
        text: S.str("Text to add (plain)."),
        at: { type: "string", enum: ["start", "end"], description: "Default end." },
        after_text: S.str("Insert right after this text in the block instead."),
        ...S.styles,
      },
      ["page_id", "block_id", "text"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      editable(await snapshot(ctx, ws), id!);
      const st = { bold: a.bold, italic: a.italic, underline: a.underline, strike: a.strike, code: a.code, textColor: a.text_color, backgroundColor: a.highlight, link: a.link || undefined };
      const hasStyle = Object.values(st).some((v) => v !== undefined);
      const r = await content(ctx, ws, id!, "insertText", { blockId: a.block_id, text: a.text, at: a.at, afterText: a.after_text, styles: hasStyle ? st : undefined });
      await touched(ctx, ws, id!);
      return r;
    },
  }),
  t({
    name: "check_todos",
    title: "Tick to-dos",
    description: "Ticks or unticks to-do (checklist) items on a page, by block id or by the text in them. Without checked, lists the to-dos and whether they're done. (Database checkbox properties: use update_rows.)",
    inputSchema: obj(
      {
        page_id: S.page,
        workspace_id: S.ws,
        checked: S.bool("true ticks, false unticks; leave out to just list."),
        block_ids: S.arr({ type: "string" }, "The to-do blocks."),
        item_text: S.str("Every to-do whose text contains this (ignoring case)."),
      },
      ["page_id"],
    ),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      if (a.checked !== undefined) editable(await snapshot(ctx, ws), id!);
      const r = await content(ctx, ws, id!, a.checked === undefined ? "read" : "setChecked", a.checked === undefined ? { format: "blocks" } : { checked: a.checked, blockIds: a.block_ids, itemText: a.item_text });
      if (a.checked === undefined) {
        const todos: any[] = [];
        const walk = (bs: any[]) =>
          bs.forEach((b) => {
            if (b.type === "checkListItem") todos.push({ id: b.id, text: b.content ?? "", checked: !!b.props?.checked });
            if (b.children) walk(b.children);
          });
        walk(r.blocks ?? []);
        return { items: todos };
      }
      await touched(ctx, ws, id!);
      return r;
    },
  }),

  // ---------------------------------------------------------------- comments
  t({
    name: "list_comments",
    title: "List comments",
    description: "The comment threads on a page: the text each is attached to, every comment with its author, and reactions.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, include_resolved: S.bool("Also resolved threads.") }, ["page_id"]),
    write: false,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      const s = await snapshot(ctx, ws);
      needPage(s, id!);
      const { threads } = await content(ctx, ws, id!, "threads", { includeResolved: !!a.include_resolved });
      const name = (u: string) => s.users[u]?.name ?? u;
      return {
        threads: threads.map((th: any) => ({
          ...th,
          created: iso(th.created),
          resolvedBy: th.resolvedBy ? name(th.resolvedBy) : undefined,
          comments: th.comments.map((c: any) => ({
            ...c,
            author: name(c.author),
            mine: c.author === ctx.user.id || undefined,
            created: iso(c.created),
            edited: iso(c.edited),
            reactions: c.reactions.map((r: any) => ({ emoji: r.emoji, by: r.by.map(name) })),
          })),
        })),
      };
    },
  }),
  t({
    name: "add_comment",
    title: "Comment",
    description: "Starts a comment thread on some text of a page (quote it exactly), or on a whole block.",
    inputSchema: obj(
      {
        page_id: S.page,
        workspace_id: S.ws,
        text: S.str("The comment (Markdown for bold, italic, links)."),
        quote: S.str("The exact text on the page the comment is about."),
        block_id: S.str("The block it's in (or, without quote, the block it's about)."),
        occurrence: { description: 'Which occurrence of the quote: "first" (default), "last" or a number.' },
      },
      ["page_id", "text"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      const s = await snapshot(ctx, ws);
      needPage(s, id!);
      if (isTrashed(s.pages, id!)) fail("That page is in the trash. Restore it first.");
      return content(ctx, ws, id!, "addComment", { text: a.text, quote: a.quote, blockId: a.block_id, occurrence: a.occurrence });
    },
  }),
  t({
    name: "reply_to_comment",
    title: "Reply to comment",
    description: "Adds a reply to a comment thread.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, thread_id: S.str("The thread."), text: S.str("The reply.") }, ["page_id", "thread_id", "text"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      return content(ctx, ws, id!, "reply", { threadId: a.thread_id, text: a.text });
    },
  }),
  t({
    name: "edit_comment",
    title: "Edit comment",
    description: "Rewrites one of this person's own comments.",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, thread_id: S.str("The thread."), comment_id: S.str("The comment."), text: S.str("The new text.") }, ["page_id", "thread_id", "comment_id", "text"]),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      return content(ctx, ws, id!, "editComment", { threadId: a.thread_id, commentId: a.comment_id, text: a.text });
    },
  }),
  t({
    name: "delete_comment",
    title: "Delete comment",
    description: "Deletes one of this person's own comments (a thread with no comments left goes too).",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, thread_id: S.str("The thread."), comment_id: S.str("The comment.") }, ["page_id", "thread_id", "comment_id"]),
    write: true,
    destructive: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      return content(ctx, ws, id!, "deleteComment", { threadId: a.thread_id, commentId: a.comment_id });
    },
  }),
  t({
    name: "resolve_comment",
    title: "Resolve comment",
    description: "Marks a comment thread resolved, or reopens it (resolved: false).",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, thread_id: S.str("The thread."), resolved: S.bool("Default true.") }, ["page_id", "thread_id"]),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      return content(ctx, ws, id!, "resolve", { threadId: a.thread_id, resolved: a.resolved !== false });
    },
  }),
  t({
    name: "react_to_comment",
    title: "React to comment",
    description: "Adds an emoji reaction to a comment, or takes it away (remove: true).",
    inputSchema: obj({ page_id: S.page, workspace_id: S.ws, thread_id: S.str("The thread."), comment_id: S.str("The comment."), emoji: S.str("One emoji."), remove: S.bool("Take the reaction away.") }, ["page_id", "thread_id", "comment_id", "emoji"]),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.page_id);
      return content(ctx, ws, id!, "react", { threadId: a.thread_id, commentId: a.comment_id, emoji: a.emoji, remove: !!a.remove });
    },
  }),

  // ---------------------------------------------------------------- databases
  t({
    name: "create_database",
    title: "Create database",
    description:
      "Creates a database (rows with properties, shown as a table, board, list, gallery, calendar, timeline or chart). Inside a page it's also shown in that page's content, like /table in the app. Without properties it gets the app's starter ones (Status, Tags, Date). Properties can be any type, with their settings: formulas, relations (two-way), rollups, number formats, status groups, IDs, buttons.",
    inputSchema: obj(
      {
        workspace_id: S.ws,
        parent_id: S.str("The page it goes in; leave out for the top level."),
        title: S.str("Database name."),
        icon: S.str("An emoji."),
        view_type: { type: "string", enum: VIEW_TYPES, description: "How it's first shown (default table)." },
        view_name: S.str("Name of that first view."),
        properties: S.arr(propertyDef, 'Properties besides "Name" (the title every row has).'),
        show_in_page: S.bool("When it's inside a page, show it in the page's content (default true)."),
        after_block_id: S.str("Where in the parent page's content to show it (default the end)."),
      },
      ["title"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws } = await locate(ctx, a, a.parent_id);
      const parentId = a.parent_id ? parseRef(a.parent_id).id : null;
      const s = parentId ? await snapshot(ctx, ws) : null;
      const inPage = !!(parentId && s?.pages[parentId]?.kind === "page" && a.show_in_page !== false);
      if (inPage) editable(s!, parentId!);
      const fields = pageFieldsFrom({ title: a.title, icon: a.icon });
      const ppl = a.properties?.some((p: any) => p?.button) ? await people(ctx, ws) : undefined;
      const created = await tree(ctx, ws, "create", { parentId, fields, database: { view: a.view_type ?? "table", viewName: a.view_name, properties: a.properties } }, ppl);
      if (inPage) {
        const source = { raw: [{ type: "database", props: { databaseId: created.id } }] };
        if (a.after_block_id) await content(ctx, ws, parentId!, "insert", { source, position: { after: a.after_block_id } });
        else await content(ctx, ws, parentId!, "write", { mode: "append", source });
        await touched(ctx, ws, parentId!);
      }
      const after = await snapshot(ctx, ws);
      return { id: created.id, url: pageUrl(ctx, ws, created.id), shown_in_page: inPage || undefined, database: dbSchema(after, after.pages[created.id]) };
    },
  }),
  t({
    name: "query_database",
    title: "Query database",
    description:
      "Lists a database's rows with their property values (formulas and rollups worked out), through one of its views (its filters, sorts and grouping) or your own. Can also work out column calculations (sum, average, counts…) and group rows.",
    inputSchema: obj(
      {
        database_id: S.page,
        workspace_id: S.ws,
        view: S.str("Use this view's filters, sorts, grouping and calculations (name or id)."),
        filters: viewSettings.filters,
        filter_mode: viewSettings.filter_mode,
        sorts: viewSettings.sorts,
        group_by: S.str("Group the rows by this property; returns each group's rows."),
        calculate: { type: "object", additionalProperties: { type: "string" }, description: 'Work these out over the matching rows, like {"Estimate": "sum", "Done": "percent_checked"}.' },
        search: S.str("Only rows with this text in any value."),
        limit: S.int("Most rows (default 100, at most 500)."),
        offset: S.int("Skip this many rows first."),
        include_content: S.bool("Also each row's page content as Markdown (at most 50 rows)."),
      },
      ["database_id"],
    ),
    write: false,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      const s = await snapshot(ctx, ws);
      const db = needDb(s, id!);
      const c = ctxOf(s);
      let filters: FilterItem[] = [];
      let filterOp: "and" | "or" | undefined;
      let sorts = [] as { propId: string; dir: "asc" | "desc" }[];
      let groupBy: string | undefined;
      let groupDate: any;
      let calcs: Record<string, string> = {};
      if (a.view) {
        const v = (db.views ?? []).find((x) => x.id === a.view || x.name.toLowerCase() === String(a.view).toLowerCase());
        if (!v) fail(`"${pageTitle(db)}" has no view "${a.view}". Views: ${(db.views ?? []).map((x) => x.name).join(", ")}.`);
        filters = v.filters;
        filterOp = v.filterOp;
        sorts = v.sorts;
        groupBy = v.groupBy;
        groupDate = v.groupDate;
        calcs = { ...(v.calcs ?? {}) };
      }
      // Filters given here apply on top of the view's own.
      const extra: FilterItem[] = a.filters?.length ? storedFilters(db, a.filters, await people(ctx, ws), () => nid(6), c) : [];
      const extraOp = a.filter_mode === "or" ? "or" : "and";
      if (a.sorts?.length) {
        sorts = a.sorts.map((x: any) => {
          const dir = String(x?.direction ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";
          return { propId: propertyOf(db, x?.property).id, dir };
        });
      }
      if (a.group_by) {
        const p = propertyOf(db, a.group_by);
        if (!canGroupBy(p)) fail(`"${p.name}" can't group rows.`);
        groupBy = p.id;
      }
      if (a.calculate) {
        if (!isObj(a.calculate)) fail('calculate is like {"Estimate": "sum"}.');
        for (const [k, fn] of Object.entries(a.calculate)) calcs[propertyOf(db, k).id] = String(fn);
      }
      let rows = viewRows(db, { filters, filterOp, sorts }, c);
      if (extra.length) rows = rows.filter((r) => passes(r, extra, extraOp, db, c));
      if (a.search) {
        const q = String(a.search).toLowerCase();
        rows = rows.filter((r) => pageTitle(r).toLowerCase().includes(q) || JSON.stringify(rowValues(s, db, r, c)).toLowerCase().includes(q));
      }
      const total = rows.length;
      const offset = Math.max(0, Number(a.offset ?? 0));
      const limit = Math.min(a.include_content ? 50 : 500, Math.max(1, Number(a.limit ?? 100)));
      const page = rows.slice(offset, offset + limit);
      const out = await Promise.all(
        page.map(async (r) => ({
          id: r.id,
          title: pageTitle(r),
          ...(r.icon ? { icon: r.icon } : {}),
          values: rowValues(s, db, r, c),
          ...(a.include_content ? { content: withTitles(s, (await content(ctx, ws, r.id, "read", { format: "markdown" })).markdown ?? "") } : {}),
        })),
      );
      const all = [{ id: "title", name: "Name" }, ...(db.properties ?? [])];
      const calcOut = (list: Page[]) => {
        const o: Record<string, string> = {};
        for (const [pid, fn] of Object.entries(calcs)) {
          const p = all.find((x) => x.id === pid) as any;
          if (p) o[p.name] = calculate(fn, list, p.id === "title" ? { id: "title", name: "Name", type: "text" } : p, c);
        }
        return o;
      };
      const groupProp = groupBy ? (all.find((x) => x.id === groupBy) as any) : undefined;
      const groups = groupProp
        ? groupRows(rows, groupProp.id === "title" ? { id: "title", name: "Name", type: "text" } : groupProp, { groupDate }, c, db).map((g) => ({
            group: g.group.key ? g.group.label : `No ${groupProp.name}`,
            count: g.rows.length,
            row_ids: g.rows.map((r) => r.id),
            ...(Object.keys(calcs).length ? { calculations: calcOut(g.rows) } : {}),
          }))
        : undefined;
      return {
        database: { id: db.id, title: pageTitle(db) },
        total,
        offset,
        rows: out,
        more: offset + page.length < total || undefined,
        ...(Object.keys(calcs).length ? { calculations: calcOut(rows) } : {}),
        ...(groups ? { grouped_by: groupProp.name, groups } : {}),
      };
    },
  }),
  t({
    name: "add_rows",
    title: "Add rows",
    description: "Adds rows to a database, with their property values and optional page content. ID properties number new rows by themselves; two-way relations update the other side.",
    inputSchema: obj(
      {
        database_id: S.page,
        workspace_id: S.ws,
        rows: S.arr(obj({ title: S.str("The row's name."), icon: S.str("An emoji."), values: valuesSchema, markdown: S.markdown, blocks: S.blocks }, ["title"]), "Rows to add (up to 200)."),
      },
      ["database_id", "rows"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      if (!Array.isArray(a.rows) || !a.rows.length || a.rows.length > 200) fail("rows is a list of 1 to 200 rows.");
      needDb(await snapshot(ctx, ws), id!);
      const ppl = await people(ctx, ws);
      const ids: string[] = [];
      for (const r of a.rows) {
        const created = await createWithContent(ctx, ws, contentSource(r), { parentId: id, fields: pageFieldsFrom({ title: r.title, icon: r.icon }), values: r.values }, ppl);
        ids.push(created.id);
      }
      return { database_id: id, row_ids: ids };
    },
  }),
  t({
    name: "update_rows",
    title: "Update rows",
    description: "Changes rows' titles, icons and property values: tick checkboxes, set status, dates and ranges, tags, people, files, related rows, numbers… (only the values given change).",
    inputSchema: obj(
      {
        workspace_id: S.ws,
        rows: S.arr(obj({ row_id: S.str("The row."), title: S.str("New name."), icon: S.str("An emoji."), values: valuesSchema }, ["row_id"]), "Rows to change."),
      },
      ["rows"],
    ),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      if (!Array.isArray(a.rows) || !a.rows.length || a.rows.length > 500) fail("rows is a list of 1 to 500 rows.");
      const { ws } = await locate(ctx, a, a.rows[0]?.row_id);
      const rows = a.rows.map((r: any) => ({ id: parseRef(r.row_id).id, title: r.title, icon: r.icon, values: r.values }));
      return tree(ctx, ws, "setValues", { rows }, await people(ctx, ws));
    },
  }),
  t({
    name: "press_button",
    title: "Press button",
    description: "Presses a button property on a database row, setting the values its actions name (as clicking it in the app does).",
    inputSchema: obj({ row_id: S.page, workspace_id: S.ws, property: S.str("The button property's name or id.") }, ["row_id", "property"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.row_id);
      return tree(ctx, ws, "pressButton", { rowId: id, property: a.property });
    },
  }),
  t({
    name: "add_property",
    title: "Add property",
    description:
      "Adds a property (column) to a database, of any type, with its settings: number formats and bars, date formats, options and status groups, relations (two-way by default), rollups, formulas, ID prefixes, buttons.",
    inputSchema: obj({ database_id: S.page, workspace_id: S.ws, ...propertyDef.properties, position: S.int("Column position among the properties (0 = first after Name).") }, ["database_id", "name", "type"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      const { database_id, workspace_id, position, ...property } = a;
      return tree(ctx, ws, "addProperty", { dbId: id, property, position }, property.button ? await people(ctx, ws) : undefined);
    },
  }),
  t({
    name: "update_property",
    title: "Change property",
    description:
      "Changes a database property: rename, describe, change type (values convert as in the app), move, edit options (status options have groups), and any of its settings — number format, decimals, bar or ring, date and time format, relation target and two-way, rollup, formula, ID prefix, button.",
    inputSchema: obj(
      {
        database_id: S.page,
        workspace_id: S.ws,
        property: S.str("Property name or id."),
        name: S.str("New name."),
        type: { type: "string", enum: PROP_TYPES },
        position: S.int("New position (0 = first after Name)."),
        ...propertySettings,
        add_options: S.arr(
          { anyOf: [{ type: "string" }, obj({ name: { type: "string" }, color: S.optionColor, group: { type: "string", enum: ["todo", "in_progress", "done"] } }, ["name"])] },
          "Options to add.",
        ),
        update_options: S.arr(obj({ option: S.str("Current name or id."), name: S.str("New name."), color: S.optionColor, group: { type: "string", enum: ["todo", "in_progress", "done"] } }, ["option"]), "Options to rename, recolour or regroup."),
        remove_options: S.arr({ type: "string" }, "Options to remove (rows using them lose that value)."),
      },
      ["database_id", "property"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      const { database_id, workspace_id, property, ...patch } = a;
      return tree(ctx, ws, "updateProperty", { dbId: id, property, patch }, patch.button ? await people(ctx, ws) : undefined);
    },
  }),
  t({
    name: "duplicate_property",
    title: "Duplicate property",
    description: "Copies a property (with its settings and every row's value) right after it.",
    inputSchema: obj({ database_id: S.page, workspace_id: S.ws, property: S.str("Property name or id."), name: S.str("Name for the copy (default: … (copy)).") }, ["database_id", "property"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      return tree(ctx, ws, "duplicateProperty", { dbId: id, property: a.property, name: a.name });
    },
  }),
  t({
    name: "delete_property",
    title: "Delete property",
    description: "Removes a property (column) and its values from a database. Its two-way mirror stays on the other database as a one-way relation.",
    inputSchema: obj({ database_id: S.page, workspace_id: S.ws, property: S.str("Property name or id.") }, ["database_id", "property"]),
    write: true,
    destructive: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      return tree(ctx, ws, "deleteProperty", { dbId: id, property: a.property });
    },
  }),
  t({
    name: "add_view",
    title: "Add view",
    description:
      "Adds a view to a database — table, board, list, gallery, calendar, timeline or chart — with its own filters (and/or groups), sorts, grouping, calculations, frozen columns, card and calendar options, and chart settings.",
    inputSchema: obj({ database_id: S.page, workspace_id: S.ws, type: { type: "string", enum: VIEW_TYPES }, ...viewSettings }, ["database_id", "type"]),
    write: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      const { database_id, workspace_id, ...view } = a;
      return tree(ctx, ws, "addView", { dbId: id, view }, a.filters?.length || a.hidden_groups ? await people(ctx, ws) : undefined);
    },
  }),
  t({
    name: "update_view",
    title: "Change view",
    description:
      "Changes a database view: name, layout, filters (and/or groups, relative dates), sorts, grouping, calculations, date properties, hidden properties, column widths, wrapping, frozen columns, how rows open, card previews and sizes, calendar weeks, timeline zoom, chart settings, position.",
    inputSchema: obj({ database_id: S.page, workspace_id: S.ws, view: S.str("View name or id."), type: { type: "string", enum: VIEW_TYPES }, ...viewSettings }, ["database_id", "view"]),
    write: true,
    idempotent: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      const { database_id, workspace_id, view, ...patch } = a;
      return tree(ctx, ws, "updateView", { dbId: id, view, patch }, a.filters?.length || a.hidden_groups ? await people(ctx, ws) : undefined);
    },
  }),
  t({
    name: "delete_view",
    title: "Delete view",
    description: "Removes a view from a database (a database keeps at least one).",
    inputSchema: obj({ database_id: S.page, workspace_id: S.ws, view: S.str("View name or id.") }, ["database_id", "view"]),
    write: true,
    destructive: true,
    run: async (ctx, a) => {
      const { ws, id } = await locate(ctx, a, a.database_id);
      return tree(ctx, ws, "deleteView", { dbId: id, view: a.view });
    },
  }),

  // ---------------------------------------------------------------- files
  t({
    name: "upload_file",
    title: "Upload file",
    description: "Stores a file (image, video, audio, PDF, document; up to 25 MB) in a workspace and returns its address, for image/video/audio/file blocks or a page cover.",
    inputSchema: obj(
      {
        workspace_id: S.ws,
        filename: S.str('File name with extension, like "photo.jpg".'),
        data_base64: S.str("The file's bytes, base64-encoded."),
        source_url: S.str("Or an https:// address to fetch the file from."),
      },
      ["filename"],
    ),
    write: true,
    run: async (ctx, a) => {
      const { ws } = await locate(ctx, a);
      let body: ArrayBuffer;
      if (a.data_base64) {
        const clean = String(a.data_base64).replace(/^data:[^,]*,/, "").replace(/\s/g, "");
        if (clean.length > 34_000_000) fail("That file is too large (25 MB at most).");
        try {
          body = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)).buffer;
        } catch {
          fail("data_base64 isn't valid base64.");
        }
      } else if (a.source_url) {
        if (!/^https:\/\//.test(a.source_url)) fail("source_url must be an https:// address.");
        const res = await fetch(a.source_url, { redirect: "follow" });
        if (!res.ok) fail(`Couldn't fetch that file (${res.status}).`);
        if (Number(res.headers.get("Content-Length") ?? 0) > 25 * 1024 * 1024) {
          await res.body?.cancel();
          fail("That file is too large (25 MB at most).");
        }
        body = await res.arrayBuffer();
      } else fail("Send the file as data_base64 or source_url.");
      const r = await saveUpload(ctx.env, ws, String(a.filename ?? "file"), body);
      if ("error" in r) fail(r.error === "too large" ? "That file is too large (25 MB at most)." : "The upload didn't work. Try again.");
      return { url: r.url, name: r.name, workspace_id: ws };
    },
  }),
];

/** What the server tells an AI when it connects. */
export function instructions(): string {
  return [
    "Sandpiper is a private shared workspace (like Notion) for notes, docs, plans, lists and databases. Everything you do here happens as the signed-in person, live: anyone with a page open sees your edits as you make them.",
    "Start with list_workspaces, then list_pages or search. Pages nest up to 8 levels; a database is a page whose rows are pages too (with property values). Ids and page links both work wherever a page_id is asked for.",
    'Read a page with get_page: Markdown by default, or format "blocks" for every block with its id, props and colours — use those ids for insert_blocks, update_block, move_block, delete_blocks, format_text and check_todos. Edit text in place with format_text, replace_text and insert_text, which keep the rest of the formatting and any comments.',
    "Markdown you write may use: <u>underline</u>, <span style=\"color:red\">colour</span>, <mark>highlight</mark>, <mark style=\"background:blue\">coloured highlight</mark>, - [ ] to-dos, > [!💡] callouts, <details><summary>toggle</summary>…</details>, [Title](page:<id>) on its own line for a link-to-page block, [Title](database:<id>) for a database shown inline, @[Title](page:<id>) for a mention, @[Name](person:<userId>) for a person, @date(YYYY-MM-DD) for a date, $TeX$ and $$TeX$$ for equations, ```mermaid / ```plantuml / ```graphviz for diagrams, :::columns … :::column … ::: for side-by-side columns, [toc], [breadcrumb], [bookmark](url) and [embed](url) on lines of their own, and <details><summary>## Title</summary> for a toggle heading.",
    `Colours (text and highlight): ${COLORS.join(", ")}. Option (tag) colours: ${OPTION_COLORS.join(", ")}. Page fonts: ${FONTS.join(", ")}. Covers: ${COVER_PRESETS.join(", ")} or an image address.`,
    "Databases work as in Notion. Property types: " +
      PROP_TYPES.join(", ") +
      '. Formulas use Notion\'s formula language (prop("Name"), if(), ifs(), dateBetween(), dateAdd(), formatDate(), format(), round(), map(), filter(), current, let(), …). Relations link rows of another database (two-way keeps both sides in step); rollups sum up a property of related rows. Views: table, board, list, gallery, calendar, timeline, chart, each with filters (and/or groups, relative dates), sorts, grouping, column calculations and layout options. query_database works out formulas, rollups, calculations and groups for you.',
    "Block types and their props: " + BLOCK_GUIDE,
    "Locked pages can't be changed until unlocked (update_page locked: false); ask the person before unlocking. Trash is reversible; delete_page_forever and delete_workspace are not, so confirm those with the person first.",
  ].join("\n\n");
}
