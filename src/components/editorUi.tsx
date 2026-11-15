// The editor's menus, as in Notion: "Turn into" (the toolbar's block type and the block menu), the formatting
// toolbar's extra buttons (inline equation, clear formatting), the block menu (duplicate, turn into, colour, copy
// link, move to), and the slash, @ and emoji menus.
import { ReactNode, useState } from "react";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  AddCommentButton,
  BasicTextStyleButton,
  BlockColorsItem,
  BlockTypeSelectItem,
  ColorStyleButton,
  CreateLinkButton,
  DefaultReactSuggestionItem,
  DragHandleMenu,
  FileCaptionButton,
  FileDeleteButton,
  FileDownloadButton,
  FilePreviewButton,
  FileRenameButton,
  FileReplaceButton,
  FormattingToolbar,
  NestBlockButton,
  RemoveBlockItem,
  TableCellMergeButton,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  TextAlignButton,
  UnnestBlockButton,
  BlockTypeSelect,
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState,
  usePortalElement,
} from "@blocknote/react";
import {
  AtSign,
  Bookmark,
  CalendarDays,
  CodeXml,
  Columns2,
  Columns3,
  Columns4,
  Copy,
  FileText,
  FolderInput,
  Globe,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Link,
  List,
  Palette,
  Trash2,
  ListChecks,
  ListOrdered,
  ListTree,
  Map as MapIcon,
  MessageSquareQuote,
  Navigation,
  Network,
  Pilcrow,
  Quote,
  Radical,
  RemoveFormatting,
  Repeat2,
  Sigma,
  SquareChevronRight,
  Table2,
  TvMinimalPlay,
  User as UserIcon,
} from "lucide-react";
import { createPageInside, getPages, getUsers, isTrashed, pageTitle, updatePage } from "../store";
import { blockUrl, go, roomName } from "../nav";
import { pageIcon } from "./Sidebar";
import { Dropdown, MenuItem, MenuLabel, MenuSep, Modal, toast } from "./ui";

const ic = (I: any) => (p: any) => <I size={p?.size ?? 16} />;

// ---------------------------------------------------------------- turn into

/** Every block type a block can become, in Notion's order. */
export const TURN_INTO: BlockTypeSelectItem[] = [
  { name: "Text", type: "paragraph", icon: ic(Pilcrow) },
  { name: "Heading 1", type: "heading", props: { level: 1, isToggleable: false }, icon: ic(Heading1) },
  { name: "Heading 2", type: "heading", props: { level: 2, isToggleable: false }, icon: ic(Heading2) },
  { name: "Heading 3", type: "heading", props: { level: 3, isToggleable: false }, icon: ic(Heading3) },
  { name: "Heading 4", type: "heading", props: { level: 4, isToggleable: false }, icon: ic(Heading4) },
  { name: "Bulleted list", type: "bulletListItem", icon: ic(List) },
  { name: "Numbered list", type: "numberedListItem", icon: ic(ListOrdered) },
  { name: "To-do list", type: "checkListItem", icon: ic(ListChecks) },
  { name: "Toggle list", type: "toggleListItem", icon: ic(SquareChevronRight) },
  { name: "Code", type: "codeBlock", icon: ic(CodeXml) },
  { name: "Quote", type: "quote", icon: ic(Quote) },
  { name: "Callout", type: "callout", icon: ic(MessageSquareQuote) },
  { name: "Block equation", type: "equation", icon: ic(Sigma) },
  { name: "Toggle heading 1", type: "heading", props: { level: 1, isToggleable: true }, icon: ic(Heading1) },
  { name: "Toggle heading 2", type: "heading", props: { level: 2, isToggleable: true }, icon: ic(Heading2) },
  { name: "Toggle heading 3", type: "heading", props: { level: 3, isToggleable: true }, icon: ic(Heading3) },
  { name: "Toggle heading 4", type: "heading", props: { level: 4, isToggleable: true }, icon: ic(Heading4) },
];

/** The text of a block's inline content, for blocks that become one with plain text (code, equation). */
function textOf(content: any): string {
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (typeof c === "string" ? c : (c.text ?? (Array.isArray(c.content) ? textOf(c.content) : "")))).join("");
}

/** Turns a block into another type; text carries over. */
export function turnInto(editor: any, block: any, item: BlockTypeSelectItem) {
  const plainTarget = item.type === "codeBlock" || item.type === "equation";
  const plainSource = block.type === "codeBlock" || block.type === "equation";
  const update: any = { type: item.type, props: item.props ?? {} };
  if (plainTarget !== plainSource) update.content = plainTarget ? textOf(block.content) : textOf(block.content);
  editor.updateBlock(block, update);
}

/** Wraps blocks into n columns: the first holds the blocks, the others start empty. */
export function intoColumns(editor: any, blocks: any[], n: number) {
  const first = blocks[0];
  const copies = blocks.map(({ id: _id, ...rest }: any) => rest);
  const cols = [{ type: "column", props: { width: 1 }, children: copies }];
  for (let i = 1; i < n; i++) cols.push({ type: "column", props: { width: 1 }, children: [{ type: "paragraph" } as any] });
  editor.transact(() => {
    editor.insertBlocks([{ type: "columnList", children: cols }], first, "before");
    editor.removeBlocks(blocks);
  });
}

// ---------------------------------------------------------------- formatting toolbar

function ToolbarButton(props: { label: string; icon: ReactNode; onClick: () => void; selected?: boolean }) {
  const C = useComponentsContext()!;
  return (
    <C.FormattingToolbar.Button className="bn-button" label={props.label} mainTooltip={props.label} icon={props.icon} onClick={props.onClick} isSelected={props.selected} />
  );
}

function InlineEquationButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  if (!editor.isEditable || !editor.schema.inlineContentSchema.inlineEquation) return null;
  return (
    <ToolbarButton
      label="Inline equation"
      icon={<Radical size={16} />}
      onClick={() => {
        const text = editor.getSelectedText();
        editor.insertInlineContent([{ type: "inlineEquation", content: text } as any]);
      }}
    />
  );
}

function ClearFormattingButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  if (!editor.isEditable) return null;
  return (
    <ToolbarButton
      label="Clear formatting"
      icon={<RemoveFormatting size={16} />}
      onClick={() => {
        editor.removeStyles({ bold: true, italic: true, underline: true, strike: true, code: true, textColor: "default", backgroundColor: "default" } as any);
        editor.focus();
      }}
    />
  );
}

export function NotionToolbar() {
  return (
    <FormattingToolbar>
      <BlockTypeSelect key="blockTypeSelect" items={TURN_INTO} />
      <TableCellMergeButton key="tableCellMergeButton" />
      <FileCaptionButton key="fileCaptionButton" />
      <FileReplaceButton key="replaceFileButton" />
      <FileRenameButton key="fileRenameButton" />
      <FileDeleteButton key="fileDeleteButton" />
      <FileDownloadButton key="fileDownloadButton" />
      <FilePreviewButton key="filePreviewButton" />
      <BasicTextStyleButton basicTextStyle="bold" key="boldStyleButton" />
      <BasicTextStyleButton basicTextStyle="italic" key="italicStyleButton" />
      <BasicTextStyleButton basicTextStyle="underline" key="underlineStyleButton" />
      <BasicTextStyleButton basicTextStyle="strike" key="strikeStyleButton" />
      <BasicTextStyleButton basicTextStyle="code" key="codeStyleButton" />
      <InlineEquationButton key="inlineEquation" />
      <CreateLinkButton key="createLinkButton" />
      <ColorStyleButton key="colorStyleButton" />
      <TextAlignButton textAlignment="left" key="textAlignLeftButton" />
      <TextAlignButton textAlignment="center" key="textAlignCenterButton" />
      <TextAlignButton textAlignment="right" key="textAlignRightButton" />
      <NestBlockButton key="nestBlockButton" />
      <UnnestBlockButton key="unnestBlockButton" />
      <ClearFormattingButton key="clearFormatting" />
      <AddCommentButton key="addCommentButton" />
    </FormattingToolbar>
  );
}

// ---------------------------------------------------------------- block menu (the ⋮⋮ handle)

function useMenuBlock() {
  const editor = useBlockNoteEditor<any, any, any>();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s: any) => s?.block });
  return { editor, block };
}

function Item(props: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  const C = useComponentsContext()!;
  return (
    <C.Generic.Menu.Item className="bn-menu-item" icon={props.icon} onClick={props.onClick}>
      {props.children}
    </C.Generic.Menu.Item>
  );
}

function DuplicateItem() {
  const { editor, block } = useMenuBlock();
  if (!block) return null;
  return (
    <Item
      icon={<Copy size={16} />}
      onClick={() => {
        const sel = editor.getSelection()?.blocks;
        const blocks = sel?.some((b: any) => b.id === block.id) ? sel : [block];
        editor.insertBlocks(blocks.map(strip), blocks[blocks.length - 1], "after");
      }}
    >
      Duplicate
    </Item>
  );
}

function TurnIntoItem() {
  const { editor, block } = useMenuBlock();
  const C = useComponentsContext()!;
  const portal = usePortalElement();
  if (!block || !editor.isEditable) return null;
  const canTurn = ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "callout", "codeBlock", "equation"].includes(block.type);
  if (!canTurn) return null;
  return (
    <C.Generic.Menu.Root position="right" sub portalElement={portal}>
      <C.Generic.Menu.Trigger sub>
        <C.Generic.Menu.Item className="bn-menu-item" subTrigger icon={<Repeat2 size={16} />}>
          Turn into
        </C.Generic.Menu.Item>
      </C.Generic.Menu.Trigger>
      <C.Generic.Menu.Dropdown sub className="bn-menu-dropdown turn-into-menu">
        {TURN_INTO.map((it) => {
          const Icon = it.icon as any;
          const on = it.type === block.type && Object.entries(it.props ?? {}).every(([k, v]) => (block.props[k] ?? false) === v);
          return (
            <C.Generic.Menu.Item key={it.name} className="bn-menu-item" icon={<Icon size={16} />} checked={on} onClick={() => turnInto(editor, block, it)}>
              {it.name}
            </C.Generic.Menu.Item>
          );
        })}
        <C.Generic.Menu.Divider />
        <C.Generic.Menu.Item className="bn-menu-item" icon={<FileText size={16} />} onClick={() => turnIntoPage(editor, block)}>
          Page
        </C.Generic.Menu.Item>
        {[2, 3, 4, 5].map((n) => (
          <C.Generic.Menu.Item key={n} className="bn-menu-item" icon={n === 2 ? <Columns2 size={16} /> : n === 3 ? <Columns3 size={16} /> : <Columns4 size={16} />} onClick={() => intoColumns(editor, [block], n)}>
            {n} columns
          </C.Generic.Menu.Item>
        ))}
      </C.Generic.Menu.Dropdown>
    </C.Generic.Menu.Root>
  );
}

/** A block becomes a page of its own (its text the title, its nested blocks the content), linked where it was. */
function turnIntoPage(editor: any, block: any) {
  const pageId = (editor as any).__pageId as string | undefined;
  if (!pageId) return;
  const title = textOf(block.content).slice(0, 200);
  const { id } = createPageInside(pageId, { title });
  const children = block.children ?? [];
  const done = () => {
    editor.replaceBlocks([block], [{ type: "pageLink", props: { pageId: id } }]);
    toast(`“${title || "Untitled"}” is a page now.`);
  };
  if (!children.length) return done();
  appendTo(id, children.map(strip)).then(done, (e) => toast(e.message));
}

/** A block as plain data, without ids (the page it goes to gives it new ones). */
const strip = (b: any): any => ({ type: b.type, props: b.props, content: b.content, children: (b.children ?? []).map(strip) });

/** Adds blocks at the end of another page, through the server (that page's document isn't open here). */
async function appendTo(pageId: string, blocks: any[]) {
  const res = await fetch("/api/append?room=" + encodeURIComponent(roomName("page-" + pageId)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "That didn't work. Try again.");
}

function CopyLinkItem() {
  const { editor, block } = useMenuBlock();
  if (!block) return null;
  return (
    <Item
      icon={<Link size={16} />}
      onClick={() => {
        const pageId = (editor as any).__pageId as string | undefined;
        if (!pageId) return;
        navigator.clipboard?.writeText(blockUrl(pageId, block.id)).then(
          () => toast("Link to block copied."),
          () => toast("Couldn't copy the link."),
        );
      }}
    >
      Copy link to block
    </Item>
  );
}

/** Dialogs a block menu item opens. The menu closes when an item is chosen, so the editor shows them. */
export const blockDialogs: { move?: (editor: any, block: any) => void } = {};

function MoveToItem() {
  const { editor, block } = useMenuBlock();
  if (!block || !editor.isEditable) return null;
  return (
    <Item icon={<FolderInput size={16} />} onClick={() => blockDialogs.move?.(editor, block)}>
      Move to
    </Item>
  );
}

/** Moves a block (with what's nested in it, or the selected blocks) to the end of another page. */
export function MoveToDialog({ editor, block, onClose }: { editor: any; block: any; onClose: () => void }) {
  const [q, setQ] = useState("");
  const pages = getPages();
  const self = (editor as any).__pageId as string | undefined;
  const list = Object.values(pages)
    .filter((p) => p.kind === "page" && p.id !== self && !isTrashed(pages, p.id) && pageTitle(p).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
  return (
    <Modal onClose={onClose} className="move-dialog">
      <div className="menu">
        <input className="menu-input" autoFocus placeholder="Move to a page…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {list.map((p) => (
          <button
            key={p.id}
            className="menu-item"
            onClick={() => {
              const sel = editor.getSelection()?.blocks;
              const blocks = sel?.some((b: any) => b.id === block.id) ? sel : [block];
              onClose();
              appendTo(p.id, blocks.map(strip)).then(
                () => {
                  editor.removeBlocks(blocks);
                  updatePage(p.id, {}, true);
                  toast(`Moved to “${pageTitle(p)}”.`, { label: "Open", run: () => go(p.id) });
                },
                (e) => toast(e.message),
              );
            }}
          >
            <span className="menu-icon">{pageIcon(p)}</span>
            <span className="menu-label">{pageTitle(p)}</span>
          </button>
        ))}
        {!list.length && <div className="muted small pad">No pages match.</div>}
      </div>
    </Modal>
  );
}

export function NotionDragHandleMenu() {
  return (
    <DragHandleMenu>
      <RemoveBlockItem>Delete</RemoveBlockItem>
      <DuplicateItem />
      <TurnIntoItem />
      <CopyLinkItem />
      <MoveToItem />
      <BlockColorsItem>Color</BlockColorsItem>
      <TableRowHeaderItem>Header row</TableRowHeaderItem>
      <TableColumnHeaderItem>Header column</TableColumnHeaderItem>
    </DragHandleMenu>
  );
}

// ---------------------------------------------------------------- slash menu additions

export function extraSlashItems(editor: any, pageId: string): DefaultReactSuggestionItem[] {
  const insert = (block: any) => () => insertOrUpdateBlockForSlashMenu(editor, block);
  const cols = (n: number, Icon: any) => ({
    title: `${n} columns`,
    subtext: `Lay blocks out side by side`,
    aliases: ["columns", "column", "layout", String(n)],
    group: "Layout",
    icon: <Icon size={18} />,
    onItemClick: () => {
      const cur = editor.getTextCursorPosition().block;
      const empty = cur.type === "paragraph" && (!cur.content || cur.content.length === 0);
      const cols: any[] = Array.from({ length: n }, () => ({ type: "column", props: { width: 1 }, children: [{ type: "paragraph" }] }));
      editor.transact(() => {
        editor.insertBlocks([{ type: "columnList", children: cols }], cur, "after");
        if (empty) editor.removeBlocks([cur]);
      });
    },
  });
  const embed = (title: string, aliases: string[], Icon: any, subtext: string) => ({
    title,
    subtext,
    aliases,
    group: "Embeds",
    icon: <Icon size={18} />,
    onItemClick: insert({ type: "embed" }),
  });
  return [
    {
      title: "Toggle heading 4",
      subtext: "Toggleable small heading",
      aliases: ["toggle", "h4", "heading4"],
      group: "Headings",
      icon: <Heading4 size={18} />,
      onItemClick: insert({ type: "heading", props: { level: 4, isToggleable: true } }),
    },
    { title: "Block equation", subtext: "Display a TeX formula", aliases: ["equation", "math", "latex", "tex", "formula"], group: "Advanced", icon: <Sigma size={18} />, onItemClick: insert({ type: "equation" }) },
    {
      title: "Inline equation",
      subtext: "A TeX formula inside text",
      aliases: ["inline equation", "math", "latex"],
      group: "Advanced",
      icon: <Radical size={18} />,
      onItemClick: () => editor.insertInlineContent([{ type: "inlineEquation", content: "" }]),
    },
    { title: "Mermaid diagram", subtext: "Flowcharts, sequences, Gantt, pies…", aliases: ["mermaid", "diagram", "flowchart", "chart", "graph"], group: "Advanced", icon: <Network size={18} />, onItemClick: insert({ type: "diagram", props: { language: "mermaid" } }) },
    { title: "PlantUML diagram", subtext: "UML diagrams, drawn by plantuml.com", aliases: ["plantuml", "uml", "diagram", "sequence"], group: "Advanced", icon: <Network size={18} />, onItemClick: insert({ type: "diagram", props: { language: "plantuml" } }) },
    { title: "Graphviz diagram", subtext: "DOT graphs", aliases: ["graphviz", "dot", "diagram", "graph"], group: "Advanced", icon: <Network size={18} />, onItemClick: insert({ type: "diagram", props: { language: "graphviz" } }) },
    { title: "Table of contents", subtext: "Links to this page's headings", aliases: ["toc", "contents", "outline"], group: "Advanced", icon: <ListTree size={18} />, onItemClick: insert({ type: "toc" }) },
    { title: "Breadcrumb", subtext: "Where this page sits", aliases: ["breadcrumb", "path"], group: "Advanced", icon: <Navigation size={18} />, onItemClick: insert({ type: "breadcrumb" }) },
    cols(2, Columns2),
    cols(3, Columns3),
    cols(4, Columns4),
    cols(5, Columns4),
    { title: "Web bookmark", subtext: "A link with its preview", aliases: ["bookmark", "link", "url", "preview"], group: "Embeds", icon: <Bookmark size={18} />, onItemClick: insert({ type: "bookmark" }) },
    embed("Embed", ["embed", "iframe", "website"], Globe, "Any web page, video or map"),
    embed("YouTube", ["youtube", "video"], TvMinimalPlay, "Embed a YouTube video"),
    embed("Google Maps", ["maps", "google maps", "map", "location"], MapIcon, "Embed a map"),
    embed("Figma", ["figma", "design"], Globe, "Embed a Figma file"),
    {
      title: "Date",
      subtext: "Today's date; click it to pick another",
      aliases: ["date", "today", "now", "day"],
      group: "Inline",
      icon: <CalendarDays size={18} />,
      onItemClick: () => editor.insertInlineContent([{ type: "dateMention", props: { date: ymdNow() } }, " "]),
    },
    {
      title: "Mention a person",
      subtext: "Type @ and a name",
      aliases: ["person", "mention", "people", "@"],
      group: "Inline",
      icon: <AtSign size={18} />,
      onItemClick: () => editor.insertInlineContent("@"),
    },
    {
      title: "Linked view of database",
      subtext: "Show a database from elsewhere here",
      aliases: ["linked", "database", "view", "existing"],
      group: "Database",
      icon: <Table2 size={18} />,
      onItemClick: () => linkedDatabase.open?.(editor, pageId),
    },
  ];
}

/** Opens the database picker for "Linked view of database" (Editor.tsx renders it). */
export const linkedDatabase: { open?: (editor: any, pageId: string) => void } = {};

const ymdNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ---------------------------------------------------------------- @ menu: pages, people, dates

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "tomorrow", "next week", "dec 3", "2026-12-03" → YYYY-MM-DD. */
function dateFromQuery(q: string): { date: string; label: string }[] {
  const out: { date: string; label: string }[] = [];
  const now = new Date();
  const at = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const plus = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  const s = q.trim().toLowerCase();
  const named: [string, Date][] = [
    ["today", plus(0)],
    ["tomorrow", plus(1)],
    ["yesterday", plus(-1)],
    ["next week", plus(7)],
  ];
  for (const [label, d] of named) if (!s || label.startsWith(s)) out.push({ date: at(d), label: label[0].toUpperCase() + label.slice(1) });
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) out.push({ date: at(new Date(+iso[1], +iso[2] - 1, +iso[3])), label: s });
  const md = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s) ?? /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?$/.exec(s);
  if (md) {
    const [mon, day] = /^\d/.test(md[1]) ? [md[2], md[1]] : [md[1], md[2]];
    const m = MONTHS.indexOf(mon);
    if (m >= 0) {
      const d = new Date(md[3] ? +md[3] : now.getFullYear(), m, +day);
      out.push({ date: at(d), label: d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) });
    }
  }
  return out;
}

export function mentionItems(editor: any, selfId: string, query: string): DefaultReactSuggestionItem[] {
  const pages = getPages();
  const users = getUsers();
  const q = query.trim().toLowerCase();
  const rank = (t: string) => (t === q ? 0 : t.startsWith(q) ? 1 : 2);
  const seen = new Map<string, number>();
  const unique = (title: string) => {
    // The menu keys its rows by title, so make same-named entries distinct with invisible padding.
    const n = seen.get(title) ?? 0;
    seen.set(title, n + 1);
    return title + "​".repeat(n);
  };
  const people = Object.values(users)
    .filter((u) => u.name.toLowerCase().includes(q))
    .slice(0, 6)
    .map((u) => ({
      title: unique(u.name),
      subtext: "Person",
      group: "People",
      icon: <UserIcon size={16} />,
      onItemClick: () => editor.insertInlineContent([{ type: "personMention", props: { userId: u.id } }, " "]),
    }));
  const dates = dateFromQuery(query).map((d) => ({
    title: unique(d.label),
    subtext: d.date,
    group: "Date",
    icon: <CalendarDays size={16} />,
    onItemClick: () => editor.insertInlineContent([{ type: "dateMention", props: { date: d.date } }, " "]),
  }));
  const pageItems = Object.values(pages)
    .filter((p) => p.id !== selfId && !isTrashed(pages, p.id) && pageTitle(p).toLowerCase().includes(q))
    .sort((a, b) => rank(pageTitle(a).toLowerCase()) - rank(pageTitle(b).toLowerCase()) || b.updatedAt - a.updatedAt)
    .slice(0, 10)
    .map((p) => {
      const parent = p.parentId ? pages[p.parentId] : undefined;
      return {
        title: unique(pageTitle(p)),
        subtext: parent ? "in " + pageTitle(parent) : undefined,
        group: "Pages",
        icon: <span style={{ fontSize: 16 }}>{pageIcon(p)}</span>,
        onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { pageId: p.id } }, " "]),
      };
    });
  return [...people, ...dates, ...pageItems];
}


// ---------------------------------------------------------------- right-click: the block menu at the cursor

/** The blocks an action applies to: the selected blocks when the clicked one is among them, otherwise just it. */
export function targetBlocks(editor: any, block: any): any[] {
  const sel = editor.getSelection()?.blocks;
  return sel?.some((b: any) => b.id === block.id) ? sel : [block];
}

export function duplicateBlocks(editor: any, blocks: any[]) {
  editor.insertBlocks(blocks.map(strip), blocks[blocks.length - 1], "after");
}

export function copyBlockLink(editor: any, block: any) {
  const pageId = (editor as any).__pageId as string | undefined;
  if (!pageId) return;
  navigator.clipboard?.writeText(blockUrl(pageId, block.id)).then(
    () => toast("Link to block copied."),
    () => toast("Couldn't copy the link."),
  );
}

const TURNABLE = ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "callout", "codeBlock", "equation"];
const BLOCK_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"];
const colorName = (c: string) => (c === "default" ? "Default" : c[0].toUpperCase() + c.slice(1));

/** What right-clicking a block shows (as in Notion): the same actions as its ⋮⋮ handle. */
export function BlockContextMenu({ editor, block, close }: { editor: any; block: any; close: () => void }) {
  const blocks = targetBlocks(editor, block);
  const editable = editor.isEditable;
  const one = blocks.length === 1;
  const props = block.props ?? {};
  const colors = "textColor" in props || "backgroundColor" in props;
  const setColor = (key: "textColor" | "backgroundColor", c: string) => {
    editor.transact(() => {
      for (const b of blocks) if (key in (b.props ?? {})) editor.updateBlock(b, { props: { [key]: c } });
    });
    close();
  };
  return (
    <div className="menu block-ctx">
      {!one && <MenuLabel>{blocks.length} blocks</MenuLabel>}
      {editable && <MenuItem icon={<Trash2 size={14} />} label="Delete" danger hint="Del" onClick={() => (editor.removeBlocks(blocks), close())} />}
      {editable && <MenuItem icon={<Copy size={14} />} label="Duplicate" onClick={() => (duplicateBlocks(editor, blocks), close())} />}
      {editable && one && TURNABLE.includes(block.type) && (
        <Dropdown side="right" width={230} trigger={(open, isOpen) => <MenuItem icon={<Repeat2 size={14} />} label="Turn into" active={isOpen} hint="›" onClick={open} />}>
          {() => (
            <div className="menu menu-scroll turn-into-list">
              {TURN_INTO.map((it) => {
                const Icon = it.icon as any;
                const on = it.type === block.type && Object.entries(it.props ?? {}).every(([k, v]) => (block.props[k] ?? false) === v);
                return <MenuItem key={it.name} icon={<Icon size={14} />} label={it.name} checked={on} onClick={() => (turnInto(editor, block, it), close())} />;
              })}
              <MenuSep />
              <MenuItem icon={<FileText size={14} />} label="Page" onClick={() => (turnIntoPage(editor, block), close())} />
              {[2, 3, 4, 5].map((n) => (
                <MenuItem
                  key={n}
                  icon={n === 2 ? <Columns2 size={14} /> : n === 3 ? <Columns3 size={14} /> : <Columns4 size={14} />}
                  label={`${n} columns`}
                  onClick={() => (intoColumns(editor, [block], n), close())}
                />
              ))}
            </div>
          )}
        </Dropdown>
      )}
      <MenuItem icon={<Link size={14} />} label="Copy link to block" onClick={() => (copyBlockLink(editor, block), close())} />
      {editable && <MenuItem icon={<FolderInput size={14} />} label="Move to" onClick={() => (close(), blockDialogs.move?.(editor, block))} />}
      {editable && colors && (
        <Dropdown side="right" width={210} trigger={(open, isOpen) => <MenuItem icon={<Palette size={14} />} label="Color" active={isOpen} hint="›" onClick={open} />}>
          {() => (
            <div className="menu menu-scroll">
              {"textColor" in props && (
                <>
                  <MenuLabel>Text color</MenuLabel>
                  {BLOCK_COLORS.map((c) => (
                    <MenuItem key={"t" + c} icon={<span className={"color-a text-" + c}>A</span>} label={colorName(c)} checked={(props.textColor ?? "default") === c} onClick={() => setColor("textColor", c)} />
                  ))}
                </>
              )}
              {"backgroundColor" in props && (
                <>
                  <MenuLabel>Background color</MenuLabel>
                  {BLOCK_COLORS.map((c) => (
                    <MenuItem key={"b" + c} icon={<span className={"swatch bg-" + c} />} label={colorName(c)} checked={(props.backgroundColor ?? "default") === c} onClick={() => setColor("backgroundColor", c)} />
                  ))}
                </>
              )}
            </div>
          )}
        </Dropdown>
      )}
    </div>
  );
}
