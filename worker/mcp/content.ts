// Operations on one page's document (its blocks and comment threads), run inside that page's document room so they
// apply atomically and reach everyone who has the page open straight away.
//
// The page's blocks live in the Yjs XML fragment "content", in BlockNote's layout:
//   blockGroup > blockContainer[id] > (the block itself: paragraph, heading, table… + its props as attributes)
//                                    + an optional blockGroup holding its nested blocks
// Comment threads live in the map "threads" (BlockNote's YjsThreadStore); a thread is attached to text by a
// "comment" mark on that text.
import * as Y from "yjs";
import { YjsThreadStore } from "@blocknote/core/yjs";
import { DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { blockSchema, buildBlockElement, buildContainers, buildGroup, isMarkKey, markAttr, readBlocks, readContainer } from "./editor";
import { blocksToMarkdown, inlineToMarkdown, markdownToBlocks, markdownToInline, plainText } from "./markdown";
import { COLORS, fail, isObj, OpCtx } from "./util";

type El = Y.XmlElement;

// ================================================================ finding blocks

const fragmentOf = (doc: Y.Doc) => doc.getXmlFragment("content");

function rootGroup(doc: Y.Doc, create: boolean): El | null {
  const frag = fragmentOf(doc);
  const first = frag.get(0) as El | undefined;
  if (first instanceof Y.XmlElement && first.nodeName === "blockGroup") return first;
  if (!create) return null;
  const group = new Y.XmlElement("blockGroup");
  frag.insert(0, [group]);
  return group;
}

interface Found {
  container: El;
  group: El;
  index: number;
  /** A column layout (a column list or one column): it holds blocks, but has no text of its own. */
  layout?: boolean;
}

/** Layout blocks (columns) are their own elements, holding blocks directly, rather than block containers. */
const LAYOUT = new Set(["columnList", "column"]);
const isLayout = (el: unknown): boolean => el instanceof Y.XmlElement && LAYOUT.has(el.nodeName);

function* walk(group: El | null): Generator<Found> {
  if (!group) return;
  const items = group.toArray();
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as El;
    if (isLayout(item)) {
      yield { container: item, group, index: i, layout: true };
      yield* walk(item);
      continue;
    }
    if (!(item instanceof Y.XmlElement) || item.nodeName !== "blockContainer") continue;
    yield { container: item, group, index: i };
    const kids = item.get(1) as El | undefined;
    if (kids instanceof Y.XmlElement && kids.nodeName === "blockGroup") yield* walk(kids);
  }
}
/** Blocks that hold text (or nothing), leaving out column layouts. */
function* textBlocks(group: El | null): Generator<Found> {
  for (const f of walk(group)) if (!f.layout) yield f;
}

function find(doc: Y.Doc, id: string): Found {
  for (const f of walk(rootGroup(doc, false))) if (f.container.getAttribute("id") === id) return f;
  fail(`There's no block with id "${id}" on this page. Read the page with format "blocks" to see block ids.`);
}
function findBlock(doc: Y.Doc, id: string): Found {
  const f = find(doc, id);
  if (f.layout) fail(`Block ${id} is a ${f.container.nodeName === "column" ? "column" : "set of columns"}: it holds blocks but no text of its own.`);
  return f;
}

const contentEl = (container: El) => container.get(0) as El;
const childGroup = (container: El): El | null => {
  if (isLayout(container)) return container;
  const g = container.get(1) as El | undefined;
  return g instanceof Y.XmlElement && g.nodeName === "blockGroup" ? g : null;
};

/**
 * Removes a block from its group, tidying up what that leaves behind: a nested group left empty goes (BlockNote
 * doesn't allow those), an empty column goes, and columns down to one become plain blocks again.
 */
function removeAt(doc: Y.Doc, f: Found) {
  f.group.delete(f.index, 1);
  const group = f.group;
  const parent = group.parent;
  if (group.nodeName === "column") {
    if (group.length > 0) return;
    if (parent instanceof Y.XmlElement && parent.nodeName === "columnList") {
      const at = parent.toArray().indexOf(group);
      if (at >= 0) removeAt(doc, { container: group, group: parent, index: at, layout: true });
    }
    return;
  }
  if (group.nodeName === "columnList") {
    if (group.length >= 2) return;
    // One column left (or none): its blocks take the place of the columns.
    const outer = parent instanceof Y.XmlElement ? parent : null;
    if (!outer) return;
    const at = outer.toArray().indexOf(group);
    const rest = group.length ? (group.get(0) as El).toArray().map((c) => (c as El).clone()) : [];
    outer.delete(at, 1);
    if (rest.length) outer.insert(at, rest);
    else if (outer.length === 0) removeAt(doc, { container: group, group: outer, index: -1 } as any);
    return;
  }
  if (group.length > 0) return;
  if (parent instanceof Y.XmlElement && parent.nodeName === "blockContainer") parent.delete(1, 1);
  else group.insert(0, buildContainers([{ type: "paragraph" }])); // the page always keeps one block
}

export interface Position {
  after?: string;
  before?: string;
  parent?: string;
  index?: number;
  at?: "start" | "end";
}

/** Where new blocks go: after/before a block, inside one (as nested blocks), or at the start or end of the page. */
function resolve(doc: Y.Doc, pos: Position | undefined): { group: El; index: number } {
  if (pos?.after) {
    const f = find(doc, pos.after);
    return { group: f.group, index: f.index + 1 };
  }
  if (pos?.before) {
    const f = find(doc, pos.before);
    return { group: f.group, index: f.index };
  }
  if (pos?.parent) {
    const f = find(doc, pos.parent);
    if (f.container.nodeName === "columnList") fail("Blocks go inside one of the columns: use a column's id as parent_block_id.");
    let kids = childGroup(f.container);
    if (!kids) {
      kids = new Y.XmlElement("blockGroup");
      f.container.insert(f.container.length, [kids]);
    }
    return { group: kids, index: clampIndex(pos.index, kids.length) };
  }
  const root = rootGroup(doc, true)!;
  if (pos?.at === "start") return { group: root, index: 0 };
  if (pos?.index !== undefined) return { group: root, index: clampIndex(pos.index, root.length) };
  return { group: root, index: endIndex(root) };
}

/** Inserts built elements, checking columns only go among columns and other blocks never do. */
function insertInto(group: El, index: number, items: El[]) {
  const cols = items.filter((c) => c.nodeName === "column");
  if (group.nodeName === "columnList" && cols.length !== items.length) fail("Only columns go next to a column. To add blocks inside a column, use its id as parent_block_id.");
  if (group.nodeName !== "columnList" && cols.length) fail("A column goes inside a set of columns (a columnList block).");
  group.insert(index, items);
}
/** Changes a column layout: a column's width, or what a column holds. Layouts have no type or text to change. */
function updateLayout(f: Found, a: any) {
  const kind = f.container.nodeName;
  if (a.type !== undefined && a.type !== kind) fail(`A ${kind === "column" ? "column" : "set of columns"} can't become another kind of block. Move its blocks out instead.`);
  if (a.content !== undefined && a.content !== null) fail("Columns hold blocks, not text: change the blocks inside them.");
  if (a.props !== undefined) for (const [k, v] of Object.entries(checkProps(kind, a.props, "props"))) f.container.setAttribute(k, v as any);
  if (a.children !== undefined) {
    const kids = normalizeBlocks(a.children, "children");
    if (kind === "columnList") {
      if (kids.length < 2 || kids.some((k) => k.type !== "column")) fail("A set of columns holds two or more column blocks.");
    } else if (!kids.length) fail("A column holds at least one block.");
    f.container.delete(0, f.container.length);
    f.container.insert(0, buildContainersIn(kind, kids));
  }
  return { block: compactBlock(readContainer(f.container)) };
}

/** Elements to put inside a column (blocks) or a column list (columns), built through a scratch layout. */
function buildContainersIn(kind: string, blocks: any[]): El[] {
  const built = buildContainers(kind === "column" ? [{ type: "columnList", children: [{ type: "column", children: blocks }, { type: "column", children: [{ type: "paragraph" }] }] }] : [{ type: "columnList", children: blocks }]);
  const list = built[0];
  const holder = kind === "column" ? (list.get(0) as El) : list;
  return holder.toArray().map((c) => (c as El).clone());
}

const clampIndex = (i: number | undefined, len: number) => (i === undefined ? len : Math.max(0, Math.min(len, Math.floor(i))));

/** The end of the page, before the empty paragraph the editor keeps at the bottom. */
function endIndex(root: El): number {
  const n = root.length;
  if (n === 0) return 0;
  const last = root.get(n - 1) as El;
  const body = last instanceof Y.XmlElement ? contentEl(last) : null;
  if (body?.nodeName === "paragraph" && body.length === 0 && !childGroup(last)) return n - 1;
  return n;
}

// ================================================================ blocks in and out

/** The block types an AI may write, their props and allowed values. */
export function describeBlocks(): Record<string, { content: string; props: Record<string, unknown> }> {
  const out: Record<string, { content: string; props: Record<string, unknown> }> = {};
  for (const [type, spec] of Object.entries(blockSchema())) {
    out[type] = {
      content: spec.content,
      props: Object.fromEntries(Object.entries(spec.propSchema).map(([k, p]) => [k, p.values ? p.values : ((p as any).type ?? typeof p.default)])),
    };
  }
  return out;
}

const STYLE_KEYS = new Set(["bold", "italic", "underline", "strike", "code", "textColor", "backgroundColor"]);

/**
 * Checks blocks written by an AI and expands the shorthand this server accepts into BlockNote's own format:
 * inline content may be a Markdown string, table rows may be plain arrays of cells. Ids are always new.
 */
export function normalizeBlocks(blocks: unknown, path = "blocks"): any[] {
  if (!Array.isArray(blocks)) fail(`${path} must be a list of blocks.`);
  if (blocks.length > 2000) fail("That's too many blocks for one change (2000 at most).");
  const schema = blockSchema();
  return blocks.map((raw, i) => {
    const at = `${path}[${i}]`;
    if (typeof raw === "string") return { type: "paragraph", content: markdownToInline(raw) };
    if (!isObj(raw)) fail(`${at} must be a block object like {"type":"paragraph","content":"text"}.`);
    const type = raw.type ?? "paragraph";
    const spec = schema[type];
    if (!spec) fail(`${at}.type "${type}" isn't a block type. Use one of: ${Object.keys(schema).join(", ")}.`);
    const block: any = { type };
    if (raw.props !== undefined) block.props = checkProps(type, raw.props, `${at}.props`);
    if (raw.content !== undefined && raw.content !== null) block.content = normalizeContent(type, spec.content, raw.content, `${at}.content`);
    if (raw.children !== undefined) block.children = normalizeBlocks(raw.children, `${at}.children`);
    if (type === "columnList" && (!block.children || block.children.length < 2 || block.children.some((c: any) => c.type !== "column")))
      fail(`${at} is a set of columns: its children are two or more {"type": "column", "children": [...]} blocks.`);
    if (type === "column" && !block.children?.length) fail(`${at} is a column: give it children (the blocks it holds).`);
    return block;
  });
}

function checkProps(type: string, props: unknown, at: string): Record<string, unknown> {
  if (!isObj(props)) fail(`${at} must be an object.`);
  const spec = blockSchema()[type].propSchema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const p = spec[k];
    if (!p) fail(`${at}.${k} isn't a prop of ${type} blocks. Its props are: ${Object.keys(spec).join(", ") || "none"}.`);
    // Props without a default (like an image's width) say their type instead.
    const kind = (p as any).type ?? typeof p.default;
    let value: unknown = v;
    if (kind === "number" && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) value = Number(v);
    if (kind === "boolean" && (v === "true" || v === "false")) value = v === "true";
    if (typeof value !== kind) fail(`${at}.${k} must be a ${kind}.`);
    if (p.values && !p.values.includes(value)) fail(`${at}.${k} must be one of: ${p.values.join(", ")}.`);
    if ((k === "textColor" || k === "backgroundColor") && !(COLORS as readonly string[]).includes(String(value))) {
      fail(`${at}.${k} must be one of: ${COLORS.join(", ")}.`);
    }
    out[k] = value;
  }
  return out;
}

function normalizeContent(type: string, kind: string, content: unknown, at: string): unknown {
  if (kind === "none") fail(`${type} blocks hold no text; leave out ${at}.`);
  if (kind === "plain" || type === "codeBlock") {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("");
    fail(`${at} must be a string (the code).`);
  }
  if (kind === "table") return normalizeTable(content, at);
  return normalizeInline(content, at);
}

function normalizeInline(content: unknown, at: string): any[] {
  if (typeof content === "string") return markdownToInline(content);
  if (!Array.isArray(content)) fail(`${at} must be text (inline Markdown) or a list of inline items.`);
  const out: any[] = [];
  content.forEach((c, i) => {
    const here = `${at}[${i}]`;
    if (typeof c === "string") return out.push(...markdownToInline(c));
    if (!isObj(c)) fail(`${here} must be a string or an inline item.`);
    if (c.type === "mention") {
      if (typeof c.props?.pageId !== "string" || !c.props.pageId) fail(`${here} is a mention; it needs props.pageId.`);
      return out.push({ type: "mention", props: { pageId: c.props.pageId } });
    }
    if (c.type === "link") {
      if (typeof c.href !== "string" || !c.href) fail(`${here} is a link; it needs href.`);
      const inner = normalizeInline(c.content ?? c.href, `${here}.content`).filter((x) => x.type === "text");
      return out.push({ type: "link", href: c.href, content: inner });
    }
    if (c.type === "inlineEquation") {
      const tex = typeof c.content === "string" ? c.content : String(c.props?.tex ?? c.text ?? "");
      return out.push({ type: "inlineEquation", content: tex });
    }
    if (c.type === "dateMention") {
      const date = String(c.props?.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(date)) fail(`${here} is a date; props.date is YYYY-MM-DD.`);
      const end = c.props?.end ? String(c.props.end) : "";
      if (end && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(end)) fail(`${here}.props.end is YYYY-MM-DD.`);
      return out.push({ type: "dateMention", props: { date, end } });
    }
    if (c.type === "personMention") {
      if (typeof c.props?.userId !== "string" || !c.props.userId) fail(`${here} mentions a person; it needs props.userId (from list_people).`);
      return out.push({ type: "personMention", props: { userId: c.props.userId } });
    }
    if (c.type !== undefined && c.type !== "text") fail(`${here}.type must be text, link, mention, personMention, dateMention or inlineEquation.`);
    if (typeof c.text !== "string") fail(`${here}.text must be a string.`);
    out.push({ type: "text", text: c.text, styles: checkStyles(c.styles, `${here}.styles`) });
  });
  return out;
}

function checkStyles(styles: unknown, at: string): Record<string, unknown> {
  if (styles === undefined || styles === null) return {};
  if (!isObj(styles)) fail(`${at} must be an object.`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (!STYLE_KEYS.has(k)) fail(`${at}.${k} isn't a text style. Styles: ${[...STYLE_KEYS].join(", ")}.`);
    if (k === "textColor" || k === "backgroundColor") {
      if (!(COLORS as readonly string[]).includes(String(v))) fail(`${at}.${k} must be one of: ${COLORS.join(", ")}.`);
      if (v !== "default") out[k] = v;
    } else if (v) out[k] = true;
  }
  return out;
}

function normalizeTable(content: unknown, at: string): any {
  const rows = Array.isArray(content) ? content : isObj(content) ? content.rows : undefined;
  if (!Array.isArray(rows) || !rows.length) fail(`${at} must be {"rows": [["cell", "cell"], ...]} (rows of cells).`);
  const out: any = {
    type: "tableContent",
    rows: rows.map((r: any, i: number) => {
      const cells = Array.isArray(r) ? r : r?.cells;
      if (!Array.isArray(cells)) fail(`${at}.rows[${i}] must be a list of cells.`);
      return {
        cells: cells.map((c: any, j: number) => {
          const here = `${at}.rows[${i}][${j}]`;
          if (isObj(c) && c.type === "tableCell") {
            const cell: any = { type: "tableCell", content: normalizeInline(c.content ?? "", `${here}.content`) };
            if (c.props !== undefined) cell.props = checkCellProps(c.props, `${here}.props`);
            return cell;
          }
          return normalizeInline(c ?? "", here);
        }),
      };
    }),
  };
  if (isObj(content)) {
    for (const k of ["headerRows", "headerCols"] as const) {
      if (content[k] !== undefined) {
        const n = Number(content[k]);
        if (!Number.isInteger(n) || n < 0 || n > 1) fail(`${at}.${k} must be 0 or 1.`);
        if (n) out[k] = n;
      }
    }
    if (Array.isArray(content.columnWidths)) out.columnWidths = content.columnWidths.map((w: any) => (typeof w === "number" && w > 0 ? w : undefined));
  }
  return out;
}

function checkCellProps(props: unknown, at: string) {
  if (!isObj(props)) fail(`${at} must be an object.`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "backgroundColor" || k === "textColor") {
      if (!(COLORS as readonly string[]).includes(String(v))) fail(`${at}.${k} must be one of: ${COLORS.join(", ")}.`);
      out[k] = v;
    } else if (k === "textAlignment") {
      if (!["left", "center", "right", "justify"].includes(String(v))) fail(`${at}.textAlignment must be left, center, right or justify.`);
      out[k] = v;
    } else if (k === "colspan" || k === "rowspan") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 50) fail(`${at}.${k} must be a whole number from 1.`);
      out[k] = n;
    } else fail(`${at}.${k} isn't a table cell prop (backgroundColor, textColor, textAlignment, colspan, rowspan).`);
  }
  return out;
}

/** A block as this server shows it: only props that differ from the default, text as inline Markdown. */
export function compactBlock(b: any): any {
  const spec = blockSchema()[b.type];
  const out: any = { id: b.id, type: b.type };
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b.props ?? {})) if (!spec || spec.propSchema[k]?.default !== v) props[k] = v;
  if (Object.keys(props).length) out.props = props;
  if (b.type === "codeBlock" || spec?.content === "plain") out.content = plainText(b.content);
  else if (b.content?.type === "tableContent") {
    const t: any = {
      rows: b.content.rows.map((r: any) =>
        r.cells.map((c: any) => {
          if (Array.isArray(c)) return inlineToMarkdown(c);
          const cp: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(c.props ?? {})) {
            if (!((k === "colspan" || k === "rowspan") && v === 1) && v !== "default" && !(k === "textAlignment" && v === "left")) cp[k] = v;
          }
          const text = inlineToMarkdown(c.content ?? []);
          return Object.keys(cp).length ? { type: "tableCell", props: cp, content: text } : text;
        }),
      ),
    };
    if (b.content.headerRows) t.headerRows = b.content.headerRows;
    if (b.content.headerCols) t.headerCols = b.content.headerCols;
    if ((b.content.columnWidths ?? []).some((w: any) => w)) t.columnWidths = b.content.columnWidths;
    out.content = t;
  } else if (Array.isArray(b.content) && b.content.length) out.content = inlineToMarkdown(b.content);
  if (b.children?.length) out.children = b.children.map(compactBlock);
  return out;
}

const idsOf = (containers: El[]) => containers.map((c) => String(c.getAttribute("id")));

// ================================================================ text inside blocks

/** The text runs (Y.XmlText) inside one block, in reading order, table cells included; nested blocks excluded. */
function textRuns(el: El): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) out.push(c);
    else if (c instanceof Y.XmlElement) out.push(...textRuns(c));
  }
  return out;
}
const runText = (t: Y.XmlText) => t.toDelta().map((d: any) => (typeof d.insert === "string" ? d.insert : "")).join("");

/** Blocks to look in: one block, or every block on the page. */
function scope(doc: Y.Doc, blockId?: string): Found[] {
  if (blockId) return [findBlock(doc, blockId)];
  return [...textBlocks(rootGroup(doc, false))];
}

interface Match {
  run: Y.XmlText;
  index: number;
  length: number;
  blockId: string;
}

function findText(doc: Y.Doc, text: string, opts: { blockId?: string; matchCase?: boolean }): Match[] {
  if (!text) fail("Say which text to look for.");
  const needle = opts.matchCase === false ? text.toLowerCase() : text;
  const out: Match[] = [];
  for (const f of scope(doc, opts.blockId)) {
    const blockId = String(f.container.getAttribute("id"));
    for (const run of textRuns(contentEl(f.container))) {
      const hay = opts.matchCase === false ? runText(run).toLowerCase() : runText(run);
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        out.push({ run, index: at, length: needle.length, blockId });
      }
    }
  }
  return out;
}

function pick(matches: Match[], occurrence: unknown, text: string): Match[] {
  if (!matches.length) fail(`"${text}" isn't on this page. Text is matched exactly (set match_case false to ignore case), within one block.`);
  if (occurrence === undefined || occurrence === "all") return matches;
  if (occurrence === "first") return [matches[0]];
  if (occurrence === "last") return [matches[matches.length - 1]];
  const n = Number(occurrence);
  if (!Number.isInteger(n) || n < 1) fail('occurrence must be "all", "first", "last" or a number from 1.');
  if (n > matches.length) fail(`"${text}" appears ${matches.length} time${matches.length === 1 ? "" : "s"}, so there's no occurrence ${n}.`);
  return [matches[n - 1]];
}

/** Formatting attributes at one character of a text run. */
function attrsAt(run: Y.XmlText, index: number): Record<string, unknown> | undefined {
  let at = 0;
  for (const d of run.toDelta() as any[]) {
    const len = typeof d.insert === "string" ? d.insert.length : 1;
    if (index < at + len) return d.attributes;
    at += len;
  }
  return undefined;
}

export interface TextStyles {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  textColor?: string;
  backgroundColor?: string;
  link?: string | null;
}

/** Text styles as the Yjs formatting attributes the editor stores (null removes a style). */
function styleAttrs(s: TextStyles): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["bold", "italic", "underline", "strike", "code"] as const) {
    if (s[k] === undefined) continue;
    out[k] = s[k] ? markAttr(k)[1] : null;
  }
  for (const k of ["textColor", "backgroundColor"] as const) {
    const v = s[k];
    if (v === undefined) continue;
    if (!(COLORS as readonly string[]).includes(String(v))) fail(`${k === "textColor" ? "text_color" : "highlight"} must be one of: ${COLORS.join(", ")}.`);
    out[k] = v === "default" ? null : markAttr(k, { stringValue: v })[1];
  }
  if (s.link !== undefined) {
    if (s.link && !/^(https?:|mailto:|tel:|\/)/i.test(s.link)) fail("link must be a web address (https://…), mailto:, tel: or a path.");
    out.link = s.link ? markAttr("link", { href: s.link })[1] : null;
  }
  if (!Object.keys(out).length) fail("Say which styles to set (for example bold: true, highlight: \"yellow\").");
  return out;
}

// ================================================================ comments

const threadStore = (doc: Y.Doc, userId: string) =>
  new YjsThreadStore(userId, doc.getMap("threads"), new DefaultThreadStoreAuth(userId, "editor"));

/** A comment body in the shape the comments editor stores: paragraphs of styled text. */
function commentBody(markdown: string): any[] {
  const text = String(markdown ?? "").trim();
  if (!text) fail("The comment is empty.");
  if (text.length > 10_000) fail("That comment is too long.");
  return text.split(/\n{2,}/).map((para) => ({
    id: crypto.randomUUID(),
    type: "paragraph",
    props: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
    content: markdownToInline(para).filter((c) => c.type === "text" || c.type === "link"),
    children: [],
  }));
}
const bodyText = (body: any) =>
  Array.isArray(body) ? body.map((b: any) => (b.content ? inlineToMarkdown(b.content) : "")).filter(Boolean).join("\n\n") : "";

/** The text each thread is attached to. */
function anchors(doc: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of textBlocks(rootGroup(doc, false))) {
    for (const run of textRuns(contentEl(f.container))) {
      for (const d of run.toDelta() as any[]) {
        if (typeof d.insert !== "string" || !d.attributes) continue;
        for (const [k, v] of Object.entries(d.attributes as Record<string, any>)) {
          if (isMarkKey(k, "comment") && v?.threadId) out.set(v.threadId, (out.get(v.threadId) ?? "") + d.insert);
        }
      }
    }
  }
  return out;
}

/** Takes a thread's mark off the text (when the thread is gone). */
function unmark(doc: Y.Doc, threadId: string) {
  for (const f of textBlocks(rootGroup(doc, false))) {
    for (const run of textRuns(contentEl(f.container))) {
      let at = 0;
      for (const d of run.toDelta() as any[]) {
        const len = typeof d.insert === "string" ? d.insert.length : 1;
        for (const [k, v] of Object.entries((d.attributes ?? {}) as Record<string, any>)) {
          if (isMarkKey(k, "comment") && v?.threadId === threadId) run.format(at, len, { [k]: null });
        }
        at += len;
      }
    }
  }
}

function threadsJSON(doc: Y.Doc, includeResolved: boolean) {
  const where = anchors(doc);
  const out: any[] = [];
  doc.getMap("threads").forEach((t: any, id: string) => {
    if (!(t instanceof Y.Map)) return;
    const resolved = !!t.get("resolved");
    if (resolved && !includeResolved) return;
    const comments = ((t.get("comments") as Y.Array<Y.Map<any>>)?.toArray() ?? []).map((c) => {
      const reactions = new Map<string, string[]>();
      (c.get("reactionsByUser") as Y.Map<Y.Map<any>> | undefined)?.forEach((r) => {
        const e = String(r.get("emoji"));
        reactions.set(e, [...(reactions.get(e) ?? []), String(r.get("userId"))]);
      });
      return {
        id: c.get("id"),
        author: c.get("userId"),
        text: c.get("deletedAt") ? null : bodyText(c.get("body")),
        deleted: !!c.get("deletedAt"),
        created: c.get("createdAt"),
        edited: c.get("updatedAt") !== c.get("createdAt") ? c.get("updatedAt") : undefined,
        reactions: [...reactions].map(([emoji, by]) => ({ emoji, by })),
      };
    });
    out.push({
      id,
      quote: where.get(id) ?? null,
      resolved,
      resolvedBy: resolved ? (t.get("resolvedBy") ?? null) : undefined,
      created: t.get("createdAt"),
      comments,
    });
  });
  return out.sort((a, b) => a.created - b.created);
}

// ================================================================ operations

export async function contentOp(doc: Y.Doc, op: string, a: any, ctx: OpCtx): Promise<any> {
  switch (op) {
    case "read": {
      const blocks = readBlocks(fragmentOf(doc));
      const threads = threadsJSON(doc, false).length;
      return {
        empty: isEmpty(blocks),
        markdown: a.format === "blocks" ? undefined : blocksToMarkdown(blocks),
        blocks: a.format === "blocks" ? blocks.map(compactBlock) : undefined,
        openComments: threads,
      };
    }
    case "text":
      return blocksToMarkdown(readBlocks(fragmentOf(doc)));

    case "write": {
      const containers = buildContainers(sourceBlocks(a.source));
      if (a.mode === "replace") {
        const root = rootGroup(doc, true)!;
        root.delete(0, root.length);
        root.insert(0, containers.length ? containers : buildContainers([{ type: "paragraph" }]));
      } else {
        const root = rootGroup(doc, true)!;
        root.insert(a.mode === "prepend" ? 0 : endIndex(root), containers);
      }
      return { blockIds: idsOf(containers) };
    }

    case "insert": {
      const containers = buildContainers(sourceBlocks(a.source));
      const { group, index } = resolve(doc, a.position);
      insertInto(group, index, containers);
      return { blockIds: idsOf(containers) };
    }

    case "update": {
      const f = find(doc, a.blockId);
      if (f.layout) return updateLayout(f, a);
      const current = readContainer(f.container);
      const body = contentEl(f.container);
      const type = a.type ?? current.type;
      const spec = blockSchema()[type];
      if (!spec) fail(`"${type}" isn't a block type. Use one of: ${Object.keys(blockSchema()).join(", ")}.`);
      const newProps = a.props !== undefined ? checkProps(type, a.props, "props") : undefined;
      const newContent = a.content !== undefined && a.content !== null ? normalizeContent(type, spec.content, a.content, "content") : undefined;
      const newChildren = a.children !== undefined ? normalizeBlocks(a.children, "children") : undefined;
      const typeChanged = type !== current.type;
      if (!typeChanged && newContent === undefined) {
        // Only props: change them in place, so the text and any comments on it are kept exactly.
        for (const [k, v] of Object.entries(newProps ?? {})) body.setAttribute(k, v as any);
      } else {
        const props: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(current.props ?? {})) if (spec.propSchema[k] !== undefined) props[k] = v;
        Object.assign(props, newProps ?? {});
        let content: unknown = newContent;
        if (content === undefined) {
          const was = blockSchema()[current.type].content;
          if (spec.content === "inline" && was === "inline") content = current.content;
          else if (spec.content === "plain" && was !== "table") content = plainText(current.content);
          else if (spec.content === "inline" && was === "plain") content = [{ type: "text", text: plainText(current.content), styles: {} }];
        }
        const block: any = { id: current.id, type, props };
        if (content !== undefined && spec.content !== "none") block.content = content;
        const fresh = buildBlockElement(block);
        f.container.delete(0, 1);
        f.container.insert(0, [fresh]);
      }
      if (newChildren !== undefined) {
        const kids = childGroup(f.container);
        if (kids) f.container.delete(1, 1);
        if (newChildren.length) f.container.insert(1, [buildGroup(newChildren)]);
      }
      return { block: compactBlock(readContainer(f.container)) };
    }

    case "delete": {
      const ids: string[] = a.blockIds;
      for (const id of ids) find(doc, id); // all or nothing
      for (const id of ids) {
        const f = [...walk(rootGroup(doc, false))].find((x) => x.container.getAttribute("id") === id);
        if (f) removeAt(doc, f); // a block inside one already deleted is gone with it
      }
      return { deleted: ids.length };
    }

    case "move": {
      const f = find(doc, a.blockId);
      const target = a.position as Position;
      const ref = target.after ?? target.before ?? target.parent;
      if (ref) {
        if (ref === a.blockId) fail("A block can't be moved next to or inside itself.");
        for (const inner of walk(childGroup(f.container))) {
          if (inner.container.getAttribute("id") === ref) fail("A block can't be moved inside one of its own nested blocks.");
        }
      }
      const copy = f.container.clone();
      removeAt(doc, f);
      const { group, index } = resolve(doc, target);
      insertInto(group, index, [copy]);
      return { moved: a.blockId };
    }

    case "formatText": {
      const attrs = styleAttrs(a.styles);
      let ranges: Match[];
      if (a.text) ranges = pick(findText(doc, a.text, a), a.occurrence, a.text);
      else {
        if (!a.blockId) fail("Say which text to format (text), or which block (block_id) to format all of.");
        const f = findBlock(doc, a.blockId);
        ranges = textRuns(contentEl(f.container)).map((run) => ({ run, index: 0, length: runText(run).length, blockId: a.blockId }));
        if (!ranges.some((r) => r.length)) fail("That block has no text to format.");
      }
      for (const r of ranges) if (r.length) r.run.format(r.index, r.length, attrs);
      return { formatted: ranges.length, blockIds: [...new Set(ranges.map((r) => r.blockId))] };
    }

    case "replaceText": {
      const matches = findText(doc, a.find, a);
      if (!matches.length) fail(`"${a.find}" isn't on this page. Text is matched exactly, within one block.`);
      const chosen = a.all === false ? [matches[0]] : matches;
      // Work from the end of each run, so earlier positions stay valid.
      for (const m of [...chosen].reverse()) {
        const attrs = attrsAt(m.run, m.index);
        m.run.delete(m.index, m.length);
        if (a.replace) m.run.insert(m.index, a.replace, attrs ? { ...attrs } : {});
      }
      return { replaced: chosen.length, blockIds: [...new Set(chosen.map((m) => m.blockId))] };
    }

    case "insertText": {
      const f = findBlock(doc, a.blockId);
      const body = contentEl(f.container);
      const kind = blockSchema()[body.nodeName]?.content;
      if (kind !== "inline" && kind !== "plain") fail(`${body.nodeName} blocks don't hold text.`);
      const attrs = a.styles ? Object.fromEntries(Object.entries(styleAttrs(a.styles)).filter(([, v]) => v !== null)) : {};
      const text = String(a.text ?? "");
      if (!text) fail("There's no text to insert.");
      if (a.afterText) {
        const m = findText(doc, a.afterText, { blockId: a.blockId })[0];
        if (!m) fail(`"${a.afterText}" isn't in that block.`);
        m.run.insert(m.index + m.length, text, a.styles ? attrs : { ...(attrsAt(m.run, m.index + m.length - 1) ?? {}) });
      } else {
        const runs = body.toArray();
        const atStart = a.at === "start";
        const edge = atStart ? runs[0] : runs[runs.length - 1];
        if (edge instanceof Y.XmlText) edge.insert(atStart ? 0 : edge.length, text, attrs);
        else {
          const run = new Y.XmlText();
          body.insert(atStart ? 0 : body.length, [run]);
          run.insert(0, text, attrs);
        }
      }
      return { block: compactBlock(readContainer(f.container)) };
    }

    case "setChecked": {
      const items: { id: string; text: string; checked: boolean }[] = [];
      const wanted = a.blockIds?.length ? new Set<string>(a.blockIds) : null;
      const q = a.itemText ? String(a.itemText).toLowerCase() : null;
      for (const f of textBlocks(rootGroup(doc, false))) {
        const body = contentEl(f.container);
        if (body?.nodeName !== "checkListItem") continue;
        const id = String(f.container.getAttribute("id"));
        const text = textRuns(body).map(runText).join("");
        if (wanted ? !wanted.has(id) : q !== null ? !text.toLowerCase().includes(q) : false) continue;
        if (a.checked !== undefined) body.setAttribute("checked", !!a.checked as any);
        items.push({ id, text, checked: a.checked !== undefined ? !!a.checked : !!body.getAttribute("checked") });
      }
      if (wanted) {
        const missing = [...wanted].filter((id) => !items.some((i) => i.id === id));
        if (missing.length) fail(`These aren't to-do items on this page: ${missing.join(", ")}.`);
      }
      if (!items.length) fail(q ? `No to-do item on this page contains "${a.itemText}".` : "This page has no to-do items.");
      return { items };
    }

    // ---- comments

    case "threads":
      return { threads: threadsJSON(doc, !!a.includeResolved) };

    case "addComment": {
      let range: Match;
      if (a.quote) range = pick(findText(doc, a.quote, { blockId: a.blockId }), a.occurrence ?? "first", a.quote)[0];
      else {
        if (!a.blockId) fail("Say which text the comment is about (quote), or which block (block_id).");
        const runs = textRuns(contentEl(findBlock(doc, a.blockId).container)).filter((r) => r.length);
        if (!runs.length) fail("That block has no text to attach a comment to. Quote some text instead.");
        range = { run: runs[0], index: 0, length: runText(runs[0]).length, blockId: a.blockId };
      }
      const thread: any = await threadStore(doc, ctx.userId).createThread({ initialComment: { body: commentBody(a.text) } });
      const [key, attrs] = markAttr("comment", { orphan: false, threadId: thread.id });
      range.run.format(range.index, range.length, { [key]: attrs });
      return { threadId: thread.id, commentId: thread.comments[0].id, blockId: range.blockId };
    }
    case "reply": {
      const c: any = await guard(() => threadStore(doc, ctx.userId).addComment({ threadId: a.threadId, comment: { body: commentBody(a.text) } }));
      return { threadId: a.threadId, commentId: c.id };
    }
    case "editComment":
      await guard(() => threadStore(doc, ctx.userId).updateComment({ threadId: a.threadId, commentId: a.commentId, comment: { body: commentBody(a.text) } }));
      return { edited: a.commentId };
    case "deleteComment": {
      await guard(() => threadStore(doc, ctx.userId).deleteComment({ threadId: a.threadId, commentId: a.commentId }));
      const gone = !doc.getMap("threads").has(a.threadId);
      if (gone) unmark(doc, a.threadId);
      return { deleted: a.commentId, threadDeleted: gone };
    }
    case "resolve": {
      const store = threadStore(doc, ctx.userId);
      await guard(() => (a.resolved === false ? store.unresolveThread({ threadId: a.threadId }) : store.resolveThread({ threadId: a.threadId })));
      return { threadId: a.threadId, resolved: a.resolved !== false };
    }
    case "react": {
      const store = threadStore(doc, ctx.userId);
      const emoji = String(a.emoji ?? "").trim();
      if (!emoji || emoji.length > 16) fail("Give one emoji to react with.");
      await guard(() =>
        a.remove
          ? store.deleteReaction({ threadId: a.threadId, commentId: a.commentId, emoji })
          : store.addReaction({ threadId: a.threadId, commentId: a.commentId, emoji }),
      );
      return { threadId: a.threadId, commentId: a.commentId, emoji, removed: !!a.remove };
    }
  }
  fail(`Unknown page operation ${op}.`);
}

/** Turns the thread store's terse errors into ones that say what to do. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const m = String(err?.message ?? err);
    if (m.includes("Thread not found")) fail("There's no comment thread with that id on this page. List the comments to see their ids.");
    if (m.includes("Comment not found")) fail("There's no comment with that id in that thread.");
    if (m.includes("Not authorized")) fail("Only the person who wrote a comment can edit or delete it.");
    if (m.includes("already deleted")) fail("That comment was already deleted.");
    throw err;
  }
}

function isEmpty(blocks: any[]) {
  return blocks.every((b) => b.type === "paragraph" && (!b.content || b.content.length === 0) && !b.children?.length);
}

/**
 * The blocks to write: Markdown or blocks from a tool's arguments (checked here, inside the document room, where
 * there's CPU time to spare), or blocks the server built itself (templates, links), which are used as they are.
 */
function sourceBlocks(src: { markdown?: unknown; blocks?: unknown; raw?: any[] }): any[] {
  if (src?.raw) return src.raw;
  return blocksFromArgs(src ?? {})!;
}

/** Markdown or blocks from a tool's arguments, as checked BlockNote blocks. */
export function blocksFromArgs(a: { markdown?: unknown; blocks?: unknown }, required = true): any[] | null {
  if (a.markdown !== undefined && a.blocks !== undefined) fail("Send either markdown or blocks, not both.");
  if (typeof a.markdown === "string") return normalizeBlocks(markdownToBlocks(a.markdown));
  if (a.blocks !== undefined) return normalizeBlocks(a.blocks);
  if (required) fail("Send the content as markdown (a string) or blocks (a list).");
  return null;
}
