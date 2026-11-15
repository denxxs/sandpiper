import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronsLeft,
  Copy,
  CornerUpLeft,
  Ellipsis,
  FileText,
  FolderInput,
  House,
  Link,
  Plus,
  Search,
  Settings,
  SquarePen,
  Star,
  StarOff,
  Table2,
  Trash2,
} from "lucide-react";
import {
  ancestorsOf,
  canMoveInto,
  canNestIn,
  childrenOf,
  createPage,
  createPageInside,
  deleteForever,
  descendantsOf,
  duplicatePage,
  isFresh,
  isTrashed,
  MAX_DEPTH,
  movePage,
  Page,
  Pages,
  pageTitle,
  restorePage,
  trashPage,
  useLocal,
  useMe,
  usePages,
  usePresence,
} from "../store";
import { go, pageUrl } from "../nav";
import { Avatar, Dropdown, MenuItem, MenuSep, Popover, relTime, toast } from "./ui";
import { WorkspaceSwitcher } from "./Workspaces";
import type { SettingsTab } from "./Settings";

/** A page's emoji, or, when it has none, a drawn page or table glyph in faded pencil (as Notion does). */
export function pageIcon(p?: Page | null): ReactNode {
  if (p?.icon) return p.icon;
  return p?.kind === "database" ? <Table2 className="page-glyph" strokeWidth={1.75} aria-hidden /> : <FileText className="page-glyph" strokeWidth={1.75} aria-hidden />;
}

/** Moves a page to the Trash with a toast that can undo it. */
export function trashWithUndo(page: Page) {
  trashPage(page.id);
  toast(`Moved "${pageTitle(page)}" to Trash`, { label: "Undo", run: () => restorePage(page.id) });
}
export function copyPageLink(page: Page) {
  navigator.clipboard?.writeText(pageUrl(page.id));
  toast("Link copied");
}

export function useFavorites(): [string[], (id: string) => void] {
  const [favs, setFavs] = useLocal<string[]>("favorites", []);
  return [favs, (id) => setFavs((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))];
}

/** A searchable list of pages, used for "Move to". */
export function PagePicker(props: { exclude?: string; onPick: (id: string | null) => void; allowRoot?: boolean }) {
  const pages = usePages();
  const [q, setQ] = useState("");
  const banned = useMemo(() => new Set(props.exclude ? [props.exclude, ...descendantsOf(pages, props.exclude)] : []), [pages, props.exclude]);
  const list = Object.values(pages)
    .filter((p) => !p.isRow && !banned.has(p.id) && !isTrashed(pages, p.id) && pageTitle(p).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
  return (
    <div className="menu">
      <input className="menu-input" autoFocus placeholder="Move page to…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="menu-scroll">
        {props.allowRoot && !q && <MenuItem icon={<House size={14} />} label="Top level of the workspace" onClick={() => props.onPick(null)} />}
        {list.map((p) => {
          // Places it can't go without passing the depth limit stay listed, greyed, so the reason is visible.
          const fits = !props.exclude || canMoveInto(pages, props.exclude, p.id);
          return (
            <MenuItem
              key={p.id}
              icon={pageIcon(p)}
              label={pageTitle(p)}
              hint={fits ? undefined : "Too deep"}
              disabled={!fits}
              onClick={() => props.onPick(p.id)}
            />
          );
        })}
        {list.length === 0 && <div className="muted small pad">No pages found.</div>}
      </div>
    </div>
  );
}

export function PageMenu({ page, close }: { page: Page; close: () => void }) {
  const [favs, toggleFav] = useFavorites();
  const fav = favs.includes(page.id);
  return (
    <div className="menu">
      <MenuItem icon={fav ? <StarOff size={14} /> : <Star size={14} />} label={fav ? "Remove from Favorites" : "Add to Favorites"} onClick={() => (toggleFav(page.id), close())} />
      <MenuItem icon={<Link size={14} />} label="Copy link" onClick={() => (copyPageLink(page), close())} />
      <MenuItem
        icon={<Copy size={14} />}
        label="Duplicate"
        onClick={async () => {
          close();
          const id = await duplicatePage(page.id);
          if (id) toast(`Duplicated "${pageTitle(page)}"`);
          if (id && !page.isRow) go(id);
        }}
      />
      {!page.isRow && (
        <Dropdown side="right" width={260} trigger={(open) => <MenuItem icon={<FolderInput size={14} />} label="Move to" hint="›" onClick={open} />}>
          {() => (
            <PagePicker
              exclude={page.id}
              allowRoot
              onPick={(target) => {
                movePage(page.id, target);
                close();
              }}
            />
          )}
        </Dropdown>
      )}
      <MenuSep />
      <MenuItem icon={<Trash2 size={14} />} label="Move to Trash" danger onClick={() => (trashWithUndo(page), close())} />
      <div className="menu-foot">Last edited {relTime(page.updatedAt)}</div>
    </div>
  );
}

type DropPos = "before" | "inside" | "after";
/** The sidebar is drawn without motion when the app first opens, and slides in whenever it is opened after that. */
let sidebarShown = false;
let dragging: string | null = null;

/** Indentation for a tree level: full steps for the first six, then small ones, so deep titles keep their room. */
const indent = (depth: number) => Math.min(120, 6 + Math.min(depth, 6) * 14 + Math.max(0, depth - 6) * 4);

const TOO_DEEP = `Pages go ${MAX_DEPTH} levels deep at most.`;

function TreeNode(props: { page: Page; pages: Pages; depth: number; activeId: string | null; expanded: Record<string, boolean>; setExpanded: (id: string, open: boolean) => void; watchers: Map<string, { name: string; color: string }[]>; }) {
  const { page, pages, depth, activeId, expanded } = props;
  const kids = childrenOf(pages, page.id);
  const open = !!expanded[page.id];
  const [drop, setDrop] = useState<DropPos | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const here = props.watchers.get(page.id) ?? [];
  const roomInside = canNestIn(pages, page.id);
  // A page that was just made inks in; children opened after the tree first drew slide down into place.
  const [fresh] = useState(() => isFresh(page));
  const drawn = useRef(false);
  useEffect(() => {
    drawn.current = true;
  }, []);

  const onDrop = (pos: DropPos) => {
    const id = dragging;
    dragging = null;
    setDrop(null);
    if (!id || id === page.id || descendantsOf(pages, id).includes(page.id)) return;
    const moved = pages[id];
    if (pos === "inside") {
      if (movePage(id, page.id)) props.setExpanded(page.id, true);
      else toast(`"${pageTitle(moved)}" can't go inside "${pageTitle(page)}". ${TOO_DEEP}`);
      return;
    }
    const sibs = childrenOf(pages, page.parentId).filter((s) => s.id !== id);
    const i = sibs.findIndex((s) => s.id === page.id);
    const prev = sibs[i - 1]?.order ?? page.order - 1;
    const next = sibs[i + 1]?.order ?? page.order + 1;
    if (!movePage(id, page.parentId, pos === "before" ? (prev + page.order) / 2 : (page.order + next) / 2)) {
      toast(`"${pageTitle(moved)}" can't go there. ${TOO_DEEP}`);
    }
  };

  const addInside = () => {
    const { id, nested } = createPageInside(page.id);
    if (nested) props.setExpanded(page.id, true);
    else toast(`"${pageTitle(page)}" is as deep as pages go, so the new page went next to it.`);
    go(id);
  };

  return (
    <div>
      <div
        className={"tree-row" + (activeId === page.id ? " active" : "") + (drop ? " drop-" + drop : "") + (fresh ? " fresh" : "")}
        style={{ paddingLeft: indent(depth) }}
        onClick={() => go(page.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        draggable
        onDragStart={(e) => {
          dragging = page.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", pageTitle(page));
        }}
        onDragEnd={() => (dragging = null)}
        onDragOver={(e) => {
          if (!dragging || dragging === page.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - r.top) / r.height;
          // A page that can't take the dragged one inside only offers "before" and "after".
          const inside = canMoveInto(pages, dragging, page.id);
          setDrop(y < 0.28 || (!inside && y < 0.5) ? "before" : y > 0.72 || !inside ? "after" : "inside");
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          if (drop) onDrop(drop);
        }}
      >
        {!roomInside && kids.length === 0 ? (
          // As deep as pages go and empty: nothing to open, so no arrow (the space keeps the titles aligned).
          <span className="tree-chevron space" aria-hidden />
        ) : (
          <button
            className={"tree-chevron" + (open ? " open" : "")}
            onClick={(e) => {
              e.stopPropagation();
              props.setExpanded(page.id, !open);
            }}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <ChevronRight size={14} />
          </button>
        )}
        <span className="tree-icon">{pageIcon(page)}</span>
        <span className={"tree-title" + (page.title.trim() ? "" : " untitled")}>{pageTitle(page)}</span>
        {here.length > 0 && (
          <span className="tree-watchers">
            {here.slice(0, 3).map((u, i) => (
              <span key={i} className="dot" style={{ background: u.color }} title={u.name + " is here"} />
            ))}
          </span>
        )}
        <span className="tree-actions">
          <Dropdown width={240} trigger={(o) => (
            <button className="icon-btn tiny" onClick={o} title="More actions">
              <Ellipsis size={14} />
            </button>
          )}>
            {(close) => <PageMenu page={page} close={close} />}
          </Dropdown>
          <button
            className="icon-btn tiny"
            title={roomInside ? "Add a page inside" : "Add a page next to this one (it's as deep as pages go)"}
            onClick={(e) => {
              e.stopPropagation();
              addInside();
            }}
          >
            <Plus size={14} />
          </button>
        </span>
      </div>
      {menuAt && (
        <Popover anchor={menuAt} onClose={() => setMenuAt(null)} width={240}>
          <PageMenu page={page} close={() => setMenuAt(null)} />
        </Popover>
      )}
      {open && (roomInside || kids.length > 0) && (
        <TreeKids animate={drawn.current}>
          {kids.length ? (
            kids.map((k) => <TreeNode key={k.id} {...props} page={k} depth={depth + 1} />)
          ) : (
            <div className="tree-empty" style={{ paddingLeft: indent(depth + 1) + 10 }}>
              No pages inside
            </div>
          )}
        </TreeKids>
      )}
    </div>
  );
}

/** A section's children. One opened after the tree first drew drops into place; whether it animates is fixed
 *  when it opens, so a later re-render never replays it. */
function TreeKids({ animate, children }: { animate: boolean; children: ReactNode }) {
  const [enter] = useState(animate);
  return <div className={"tree-kids" + (enter ? " enter" : "")}>{children}</div>;
}

function TrashPanel({ close }: { close: () => void }) {
  const pages = usePages();
  const [q, setQ] = useState("");
  const list = Object.values(pages)
    .filter((p) => p.trashed && pageTitle(p).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  return (
    <div className="menu">
      <input className="menu-input" autoFocus placeholder="Search pages in Trash" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="menu-scroll">
        {list.length === 0 && <div className="muted small pad">Trash is empty.</div>}
        {list.map((p) => (
          <div key={p.id} className="trash-row">
            <span className="tree-icon">{pageIcon(p)}</span>
            <span className="trash-title">
              {pageTitle(p)}
              <span className="muted small"> · {relTime(p.trashedAt)}</span>
            </span>
            <button
              className="icon-btn tiny"
              title="Restore"
              onClick={() => {
                restorePage(p.id);
                if (!p.isRow) go(p.id);
                close();
              }}
            >
              <CornerUpLeft size={14} />
            </button>
            <button
              className="icon-btn tiny"
              title="Delete permanently"
              onClick={() => confirm(`Permanently delete "${pageTitle(p)}" and everything inside it? This can't be undone.`) && deleteForever(p.id)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="menu-foot">Pages stay in Trash until you delete them.</div>
    </div>
  );
}

export function Sidebar(props: { activeId: string | null; onSearch: () => void; onSettings: (tab?: SettingsTab) => void; onCollapse: () => void; width: number; setWidth: (w: number) => void; }) {
  const pages = usePages();
  const me = useMe();
  const presence = usePresence();
  const [favs] = useFavorites();
  const [expandedMap, setExpandedMap] = useLocal<Record<string, boolean>>("expanded", {});
  const setExpanded = (id: string, open: boolean) => setExpandedMap((m) => ({ ...m, [id]: open }));

  // As in Notion: going to a page opens the path to it in the sidebar and brings its row into view. It runs on
  // navigation only, so collapsing a section afterwards sticks.
  useEffect(() => {
    if (!props.activeId) return;
    const path = ancestorsOf(pages, props.activeId);
    if (path.some((a) => !expandedMap[a.id])) {
      setExpandedMap((m) => {
        const next = { ...m };
        for (const a of path) next[a.id] = true;
        return next;
      });
    }
    requestAnimationFrame(() => document.querySelector(".sidebar .side-scroll .tree-row.active")?.scrollIntoView({ block: "nearest" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.activeId]);
  const roots = childrenOf(pages, null);
  const favPages = favs.map((id) => pages[id]).filter((p) => p && !isTrashed(pages, p.id));
  const [rootDrop, setRootDrop] = useState(false);
  const [enter] = useState(() => sidebarShown || matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    sidebarShown = true;
  }, []);

  const watchers = useMemo(() => {
    const m = new Map<string, { name: string; color: string }[]>();
    for (const p of presence) if (p.pageId) m.set(p.pageId, [...(m.get(p.pageId) ?? []), p.user]);
    return m;
  }, [presence]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => props.setWidth(Math.max(200, Math.min(480, ev.clientX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const tree = { pages, activeId: props.activeId, expanded: expandedMap, setExpanded, watchers };

  return (
    <nav className={"sidebar" + (enter ? " enter" : "")} style={{ width: props.width }}>
      <div className="side-head">
        <WorkspaceSwitcher onSettings={props.onSettings} />
        <button className="icon-btn" onClick={props.onCollapse} title="Close sidebar (Ctrl+\)">
          <ChevronsLeft size={16} />
        </button>
      </div>

      <div className="side-links">
        <button className="side-link" onClick={props.onSearch}>
          <Search size={15} /> Search <kbd>Ctrl K</kbd>
        </button>
        <button className="side-link" onClick={() => go(createPage({ parentId: null }))}>
          <SquarePen size={15} /> New page
        </button>
      </div>

      <div className="side-scroll">
        {favPages.length > 0 && (
          <>
            <div className="side-section">Favorites</div>
            {favPages.map((p) => (
              <TreeNode key={"fav-" + p.id} {...tree} page={p} depth={0} />
            ))}
          </>
        )}
        <div className="side-section">
          Pages
          <button className="icon-btn tiny" title="Add a page" onClick={() => go(createPage({ parentId: null }))}>
            <Plus size={14} />
          </button>
        </div>
        {roots.map((p) => (
          <TreeNode key={p.id} {...tree} page={p} depth={0} />
        ))}
        {roots.length === 0 && <div className="tree-empty" style={{ paddingLeft: 12 }}>No pages yet</div>}
        <div
          className={"root-drop" + (rootDrop ? " over" : "")}
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            setRootDrop(true);
          }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={(e) => {
            e.preventDefault();
            setRootDrop(false);
            if (dragging) movePage(dragging, null);
            dragging = null;
          }}
        />
      </div>

      <div className="side-foot">
        <Dropdown width={340} side="right" trigger={(open) => (
          <button className="side-link" onClick={open}>
            <Trash2 size={15} /> Trash
          </button>
        )}>
          {(close) => <TrashPanel close={close} />}
        </Dropdown>
        <button className="side-link" onClick={() => props.onSettings()}>
          <Settings size={15} /> Settings
        </button>
        {me && (
          <div className="side-me">
            <Avatar user={me} size={22} />
            <span className="tree-title">{me.name}</span>
            {presence.length > 0 && <span className="muted small">+{new Set(presence.map((p) => p.user.id)).size} online</span>}
          </div>
        )}
      </div>
      <div className="side-resize" onMouseDown={startResize} />
    </nav>
  );
}
