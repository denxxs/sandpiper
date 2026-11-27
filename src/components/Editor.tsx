import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { BlockNoteSchema, createHeadingBlockSpec, createUserStore, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { notionCodeBlock } from "./codeBlock";
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu, SyntaxHighlightingExtension } from "@blocknote/core/extensions";
import { CommentsExtension, DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { withCollaboration, YjsThreadStore } from "@blocknote/core/yjs";
import {
  BlockNoteViewEditor,
  createReactBlockSpec,
  createReactInlineContentSpec,
  DefaultReactSuggestionItem,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  ThreadsSidebar,
  useCreateBlockNote,
  useThreads,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { CalendarDays, ChartGantt, ChartColumn, FileText, GalleryHorizontalEnd, Kanban, List, MessageSquare, MessageSquareQuote, Table2, X } from "lucide-react";
import { BLOCKS, HEADING_OPTIONS, INLINES } from "../../shared/blocks";
import {
  canNestIn,
  createPageInside,
  defaultDatabase,
  getPages,
  getUsers,
  isTrashed,
  MAX_DEPTH,
  pageTitle,
  touchPage,
  updatePage,
  usePages,
  User,
  useUsers,
  ViewType,
  WS_URL,
} from "../store";
import { go, roomName, useRoute } from "../nav";
import { TEMPLATES } from "../templates";
import { Dropdown, EmojiPicker, ErrorBoundary, Modal, Popover, toast, uploadFile } from "./ui";
import { pageIcon } from "./Sidebar";
import { DatabaseView } from "./Database";
import {
  BookmarkBlock,
  BreadcrumbBlock,
  ColumnBlock,
  ColumnListBlock,
  DateMention,
  DiagramBlock,
  editorPage,
  EmbedBlock,
  EquationBlock,
  flashBlock,
  InlineEquation,
  PersonMention,
  TocBlock,
} from "./blocks";
import { BlockContextMenu, blockDialogs, extraSlashItems, linkedDatabase, mentionItems, MoveToDialog, NotionDragHandleMenu, NotionToolbar } from "./editorUi";

/** Live editors by page id, so menus outside the editor can export / import. */
export const editors = new Map<string, any>();

// ---------------------------------------------------------------- custom blocks

const Callout = createReactBlockSpec(BLOCKS.callout as any, {
  render: (props: any) => (
    <div className="callout">
      <Dropdown
        trigger={(open) => (
          <button className="callout-emoji" contentEditable={false} onMouseDown={(e) => e.preventDefault()} onClick={(e) => props.editor.isEditable && open(e)}>
            {props.block.props.emoji}
          </button>
        )}
      >
        {(close) => (
          <EmojiPicker
            onPick={(emoji) => {
              props.editor.updateBlock(props.block, { props: { emoji } });
              close();
            }}
          />
        )}
      </Dropdown>
      <div className="callout-body" ref={props.contentRef} />
    </div>
  ),
});

function PageRef({ pageId, inline }: { pageId: string; inline?: boolean }) {
  const pages = usePages();
  const page = pages[pageId];
  const gone = !page || isTrashed(pages, pageId);
  const Tag = inline ? "span" : "div";
  return (
    <Tag className={(inline ? "mention" : "page-link") + (gone ? " gone" : "")} contentEditable={false} onClick={() => !gone && go(pageId)} role="link">
      <span className="page-link-icon">{pageIcon(page)}</span>
      <span className="page-link-title">{gone ? "Deleted page" : pageTitle(page)}</span>
    </Tag>
  );
}

const PageLink = createReactBlockSpec(BLOCKS.pageLink as any, { render: (props: any) => <PageRef pageId={props.block.props.pageId} /> });

const DatabaseBlock = createReactBlockSpec(BLOCKS.database as any, {
  render: (props: any) => (
    <div className="inline-db" contentEditable={false}>
      <DatabaseView dbId={props.block.props.databaseId} inline />
    </div>
  ),
});

const Mention = createReactInlineContentSpec(INLINES.mention as any, { render: (props: any) => <PageRef pageId={props.inlineContent.props.pageId} inline /> } as any);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    heading: createHeadingBlockSpec(HEADING_OPTIONS as any),
    codeBlock: notionCodeBlock(),
    callout: Callout(),
    pageLink: PageLink(),
    database: DatabaseBlock(),
    equation: EquationBlock(),
    diagram: DiagramBlock(),
    toc: TocBlock(),
    breadcrumb: BreadcrumbBlock(),
    bookmark: BookmarkBlock(),
    embed: EmbedBlock(),
    columnList: ColumnListBlock(),
    column: ColumnBlock(),
  } as any,
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: Mention,
    dateMention: DateMention,
    personMention: PersonMention,
    inlineEquation: InlineEquation,
  } as any,
});

/** Code highlighting: Shiki, loaded the first time a page shows code. Each language loads when first used. */
const highlighting = SyntaxHighlightingExtension({
  createHighlighter: async () => {
    const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki"), import("shiki/engine/javascript")]);
    return createHighlighter({ themes: ["github-light", "github-dark"], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }) as any;
  },
});

// ---------------------------------------------------------------- menus

function slashItems(editor: any, pageId: string) {
  // A page at the depth limit can't hold more pages; new ones go next to it and are linked or shown here instead.
  const room = canNestIn(getPages(), pageId);
  const tooDeep = (what: string) =>
    toast(`This page is as deep as pages go (${MAX_DEPTH} levels), so the new ${what} went next to it. It's ${what === "page" ? "linked" : "shown"} here.`);
  const db = (type: ViewType, title: string, icon: React.JSX.Element) => ({
    title,
    subtext: room ? `Add a database shown as a ${type}` : `Add a ${type} database next to this page, shown here`,
    aliases: ["database", "db", type],
    group: "Database",
    icon,
    onItemClick: () => {
      const { id, nested } = createPageInside(pageId, defaultDatabase(type));
      insertOrUpdateBlockForSlashMenu(editor, { type: "database", props: { databaseId: id } } as any);
      if (!nested) tooDeep("database");
    },
  });
  // The menu shows a heading per group, so items of one group must be next to each other.
  return byGroup([
    ...getDefaultReactSlashMenuItems(editor),
    {
      title: "Callout",
      subtext: "Make a note stand out",
      aliases: ["callout", "note", "info", "tip"],
      group: "Basic blocks",
      icon: <MessageSquareQuote size={18} />,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "callout" } as any),
    },
    {
      title: "Page",
      subtext: room ? "Nest a new page inside this one" : "This page is as deep as pages go: adds one next to it",
      aliases: ["page", "subpage", "new page"],
      group: "Basic blocks",
      icon: <FileText size={18} />,
      onItemClick: () => {
        const { id, nested } = createPageInside(pageId);
        insertOrUpdateBlockForSlashMenu(editor, { type: "pageLink", props: { pageId: id } } as any);
        if (!nested) tooDeep("page");
        go(id);
      },
    },
    db("table", "Table view", <Table2 size={18} />),
    db("board", "Board view", <Kanban size={18} />),
    db("list", "List view", <List size={18} />),
    db("gallery", "Gallery view", <GalleryHorizontalEnd size={18} />),
    db("calendar", "Calendar view", <CalendarDays size={18} />),
    db("timeline", "Timeline view", <ChartGantt size={18} />),
    db("chart", "Chart view", <ChartColumn size={18} />),
    ...extraSlashItems(editor, pageId),
  ]);
}

function byGroup<T extends { group?: string }>(items: T[]): T[] {
  const order: string[] = [];
  for (const i of items) if (!order.includes(i.group ?? "")) order.push(i.group ?? "");
  return order.flatMap((g) => items.filter((i) => (i.group ?? "") === g));
}

function avatarUrl(u: { name: string; color: string }) {
  const letter = ((u.name ?? "").trim()[0] ?? "?").toUpperCase().replace(/[<>&"']/g, "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${u.color}"/><text x="16" y="21.5" font-family="sans-serif" font-size="15" font-weight="600" fill="white" text-anchor="middle">${letter}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function isEmptyDoc(editor: any): boolean {
  const doc = editor.document;
  if (doc.length === 0) return true;
  if (doc.length > 1) return false;
  const b = doc[0];
  return b.type === "paragraph" && Array.isArray(b.content) && b.content.length === 0 && (b.children?.length ?? 0) === 0;
}

/** "Linked view of database": pick a database from anywhere in the workspace and show it here. */
function LinkedDatabasePicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const pages = usePages();
  const [q, setQ] = useState("");
  const dbs = Object.values(pages)
    .filter((p) => p.kind === "database" && !isTrashed(pages, p.id) && pageTitle(p).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <Modal onClose={onClose} className="move-dialog">
      <div className="menu">
        <input className="menu-input" autoFocus placeholder="Show which database here?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {dbs.map((d) => (
          <button key={d.id} className="menu-item" onClick={() => onPick(d.id)}>
            <span className="menu-icon">{pageIcon(d)}</span>
            <span className="menu-label">{pageTitle(d)}</span>
          </button>
        ))}
        {!dbs.length && <div className="muted small pad">There are no databases in this workspace yet.</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- editor

interface Conn {
  doc: Y.Doc;
  provider: WebsocketProvider;
}

export function PageEditor(props: {
  pageId: string;
  me: User;
  editable: boolean;
  theme: "light" | "dark";
  showComments: boolean;
  onCloseComments: () => void;
  onEmptyChange?: (empty: boolean) => void;
}) {
  const [conn, setConn] = useState<Conn | null>(null);
  const [synced, setSynced] = useState(false);
  // Set when the page hasn't loaded after a while, so the person gets a message and a way to retry.
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(WS_URL, roomName("page-" + props.pageId), doc);
    const onSync = (s: boolean) => s && setSynced(true);
    provider.on("sync", onSync);
    setConn({ doc, provider });
    setSynced(false);
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), 10_000);
    return () => {
      clearTimeout(timer);
      provider.destroy();
      doc.destroy();
    };
  }, [props.pageId, attempt]);

  if (!conn || !synced) {
    return (
      <>
        <div className="editor-skeleton" aria-busy="true">
          <div style={{ width: "70%" }} />
          <div style={{ width: "92%" }} />
          <div style={{ width: "55%" }} />
        </div>
        {stalled && (
          <div className="muted small pad" role="alert">
            This page can't be loaded right now. Check your connection.{" "}
            <button className="btn-outline small" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </>
    );
  }
  return <EditorInner key={props.pageId} conn={conn} {...props} />;
}

/** A workspace member as the comments UI wants them. Unknown ids get a neutral stand-in rather than nothing. */
function commentUser(id: string) {
  const u: { name: string; color: string; avatar?: string | null } = getUsers()[id] ?? { name: "Unknown", color: "#6f6b63" };
  return { id, username: u.name || "Unknown", avatarUrl: u.avatar || avatarUrl(u), color: u.color };
}

/** Every user id a page's comment threads mention: authors, reactions, and whoever resolved a thread. */
function threadUserIds(threads: Y.Map<unknown>): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "userId" || k === "resolvedBy") && typeof x === "string") ids.add(x);
      else if (k === "userIds" && Array.isArray(x)) x.forEach((id) => typeof id === "string" && ids.add(id));
      else walk(x);
    }
  };
  walk(threads.toJSON());
  return [...ids];
}

function EditorInner(props: Parameters<typeof PageEditor>[0] & { conn: Conn }) {
  const { conn, pageId, me } = props;
  const users = useUsers();
  const route = useRoute();
  const [picking, setPicking] = useState<null | { editor: any }>(null);
  const [moving, setMoving] = useState<null | { editor: any; block: any }>(null);
  const [blockMenu, setBlockMenu] = useState<null | { block: any; x: number; y: number }>(null);

  // BlockNote looks people up in this cache while it draws a thread, and its resolved-thread view throws if the
  // person who resolved it isn't there yet (which blanked the whole app). Everyone is known locally, so fill the
  // cache up front and keep it filled, instead of letting BlockNote load people lazily after the first draw.
  const userStore = useMemo(() => {
    const store = createUserStore(async (ids) => ids.map(commentUser));
    store.setUser([...new Set([...Object.keys(getUsers()), ...threadUserIds(conn.doc.getMap("threads"))])].map(commentUser));
    return store;
  }, [conn]);
  useEffect(() => {
    const threads = conn.doc.getMap("threads");
    const fill = () => {
      const missing = threadUserIds(threads).filter((id) => !userStore.getUser(id));
      if (missing.length) userStore.setUser(missing.map(commentUser));
    };
    threads.observeDeep(fill);
    return () => threads.unobserveDeep(fill);
  }, [conn, userStore]);
  // Name, colour or photo changed: show the new one in comments too.
  useEffect(() => {
    userStore.setUser(Object.keys(users).map(commentUser));
  }, [users, userStore]);

  const options = useMemo(() => {
    const threadStore = new YjsThreadStore(me.id, conn.doc.getMap("threads"), new DefaultThreadStoreAuth(me.id, "editor"));
    return withCollaboration({
      schema,
      uploadFile,
      tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
      collaboration: {
        provider: conn.provider,
        fragment: conn.doc.getXmlFragment("content"),
        user: { id: me.id, name: me.name, color: me.color },
        showCursorLabels: "activity" as const,
      },
      extensions: [
        CommentsExtension({
          threadStore,
          confirmBeforeDiscard: false,
          resolveUsers: userStore,
        }),
        highlighting,
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, userStore]);

  const editor = useCreateBlockNote(options, [options]) as any;

  useEffect(() => {
    editors.set(pageId, editor);
    editorPage.set(editor, pageId);
    editor.__pageId = pageId;
    linkedDatabase.open = (ed) => setPicking({ editor: ed });
    blockDialogs.move = (ed, block) => setMoving({ editor: ed, block });

    // Apply starter content exactly once, the first time a templated page is opened.
    const page = getPages()[pageId];
    if (page?.template) {
      const tpl = TEMPLATES[page.template];
      updatePage(pageId, { template: undefined }, false);
      if (tpl && isEmptyDoc(editor)) editor.replaceBlocks(editor.document, tpl.blocks);
    }
    props.onEmptyChange?.(isEmptyDoc(editor));

    const off = editor.onChange(() => {
      touchPage(pageId);
      props.onEmptyChange?.(isEmptyDoc(editor));
    });
    return () => {
      off?.();
      if (editors.get(pageId) === editor) editors.delete(pageId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pageId]);

  // A link to one block (#/page?b=block): scroll to it once it's drawn.
  useEffect(() => {
    if (!route.block || route.pageId !== pageId) return;
    let tries = 0;
    const t = setInterval(() => {
      if (flashBlock(route.block!) || ++tries > 20) clearInterval(t);
    }, 150);
    return () => clearInterval(t);
  }, [route.block, route.pageId, pageId]);

  // Right-click shows the block's menu (as in Notion), not the browser's.
  const onContextMenu = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return; // something inside (a database row) showed its own menu
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    e.preventDefault();
    const outer = target.closest('.bn-editor [data-node-type="blockOuter"]') as HTMLElement | null;
    const block = outer?.dataset.id ? editor.getBlock(outer.dataset.id) : undefined;
    if (block) setBlockMenu({ block, x: e.clientX, y: e.clientY });
  };

  return (
    <div className="editor-host" onContextMenu={onContextMenu}>
    <BlockNoteView editor={editor} editable={props.editable} theme={props.theme} slashMenu={false} formattingToolbar={false} sideMenu={false} renderEditor={false}>
      <BlockNoteViewEditor />
      <FormattingToolbarController formattingToolbar={NotionToolbar} />
      <SideMenuController sideMenu={(p) => <SideMenu {...p} dragHandleMenu={NotionDragHandleMenu} />} />
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async (query): Promise<DefaultReactSuggestionItem[]> => filterSuggestionItems(slashItems(editor, pageId) as any[], query)}
      />
      <SuggestionMenuController triggerCharacter="@" getItems={async (query): Promise<DefaultReactSuggestionItem[]> => mentionItems(editor, pageId, query)} />
      {props.showComments && <CommentsPanel onClose={props.onCloseComments} />}
      {moving && <MoveToDialog editor={moving.editor} block={moving.block} onClose={() => setMoving(null)} />}
      {blockMenu && (
        <Popover anchor={{ x: blockMenu.x, y: blockMenu.y }} onClose={() => setBlockMenu(null)} width={240}>
          <BlockContextMenu editor={editor} block={blockMenu.block} close={() => setBlockMenu(null)} />
        </Popover>
      )}
      {picking && (
        <LinkedDatabasePicker
          onClose={() => setPicking(null)}
          onPick={(id) => {
            insertOrUpdateBlockForSlashMenu(picking.editor, { type: "database", props: { databaseId: id } } as any);
            setPicking(null);
          }}
        />
      )}
    </BlockNoteView>
    </div>
  );
}

/** The page's comment threads, open or resolved (as in Notion), with an empty state that says how to start one. */
function CommentsPanel({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const threads = useThreads();
  const count = [...threads.values()].filter((t) => (filter === "open" ? !t.resolved : t.resolved)).length;
  return (
    <aside className="comments-panel" aria-label="Comments">
      <div className="panel-head">
        <span>Comments</span>
        <div className="comments-filter" role="tablist" aria-label="Which comments">
          {(["open", "resolved"] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {f === "open" ? "Open" : "Resolved"}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose} title="Close comments">
          <X size={16} />
        </button>
      </div>
      <div className="comments-scroll">
        <ErrorBoundary
          fallback={(_, retry) => (
            <div className="panel-error">
              <p className="muted small">The comments on this page couldn't be shown. They're still saved.</p>
              <button className="btn-ghost" onClick={retry}>
                Try again
              </button>
            </div>
          )}
        >
          <ThreadsSidebar filter={filter} sort="position" />
        </ErrorBoundary>
        {count === 0 && (
          <div className="comments-empty">
            <MessageSquare size={22} strokeWidth={1.75} />
            <b>{filter === "open" ? "No open comments" : "No resolved comments"}</b>
            <span className="small">
              {filter === "open" ? "Select some text on the page and choose Comment in the toolbar that appears." : "Comments you resolve are kept here."}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Replace an (empty) page's content with a template. */
export function applyTemplate(pageId: string, key: string) {
  const editor = editors.get(pageId);
  const tpl = TEMPLATES[key];
  if (!editor || !tpl) return;
  editor.replaceBlocks(editor.document, tpl.blocks);
}
