import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Copy,
  CornerUpLeft,
  Download,
  Ellipsis,
  FolderInput,
  GalleryHorizontalEnd,
  Image as ImageIcon,
  Kanban,
  Link,
  List,
  Lock,
  LockOpen,
  Menu,
  MessageSquare,
  Smile,
  Star,
  Table2,
  Trash2,
  Upload,
  WifiOff,
} from "lucide-react";
import {
  ancestorsOf,
  defaultDatabase,
  deleteForever,
  duplicatePage,
  isTrashed,
  movePage,
  Page,
  pageTitle,
  restorePage,
  updatePage,
  useMe,
  useOnline,
  usePages,
  usePresence,
  useUsers,
  ViewType,
} from "../store";
import { go, pageUrl } from "../nav";
import { TEMPLATES } from "../templates";
import { Avatar, COVERS, coverStyle, Dropdown, EmojiPicker, MenuItem, MenuLabel, MenuSep, relTime, toast, Toggle, uploadFile } from "./ui";
import { applyTemplate, editors, PageEditor } from "./Editor";
import { DatabaseView, RowProperties } from "./Database";
import { copyPageLink, pageIcon, PagePicker, trashWithUndo, useFavorites } from "./Sidebar";

// ---------------------------------------------------------------- top bar

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const safeName = (p: Page) => pageTitle(p).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Untitled";

export function Topbar(props: { page: Page | null; sidebarOpen: boolean; onOpenSidebar: () => void; showComments: boolean; setShowComments: (v: boolean) => void; }) {
  const { page } = props;
  const pages = usePages();
  const users = useUsers();
  const connected = useOnline();
  // Brief reconnects are normal; only call it Offline when the connection stays down for a few seconds.
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (connected) return setOnline(true);
    const t = setTimeout(() => setOnline(false), 4000);
    return () => clearTimeout(t);
  }, [connected]);
  const presence = usePresence();
  const [favs, toggleFav] = useFavorites();
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const crumbs = page ? [...ancestorsOf(pages, page.id), page] : [];
  // Breadcrumbs fold to the room the bar actually has: wide keeps the first page and the last two, medium the
  // first page and this one, a phone just this one. Everything between goes into "…".
  const barRef = useRef<HTMLElement>(null);
  const [barWidth, setBarWidth] = useState(1200);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setBarWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const showFirst = barWidth >= 560;
  const tail = barWidth >= 880 ? 2 : 1;
  const folds = crumbs.length > tail + (showFirst ? 1 : 0);
  const hiddenCrumbs = folds ? crumbs.slice(showFirst ? 1 : 0, crumbs.length - tail) : [];
  const shownCrumbs: (Page | null)[] = folds ? [...(showFirst ? [crumbs[0]] : []), null, ...crumbs.slice(-tail)] : crumbs;
  const here = page ? presence.filter((p) => p.pageId === page.id) : [];
  const uniqueHere = [...new Map(here.map((p) => [p.user.id, p.user])).values()];
  const isDoc = page?.kind === "page";
  const copyLink = () => {
    if (!page) return;
    navigator.clipboard?.writeText(pageUrl(page.id));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <header className="topbar" ref={barRef}>
      {!props.sidebarOpen && (
        <button className="icon-btn" onClick={props.onOpenSidebar} title="Open sidebar (Ctrl+\)">
          <Menu size={17} />
        </button>
      )}
      <nav className="crumbs" aria-label="Where this page is">
        {shownCrumbs.map((c, i) => (
          <span key={c?.id ?? "more"} className={"crumb-wrap" + (c?.id === page?.id ? " current" : "")}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {c ? (
              <button className="crumb" onClick={() => go(c.id)} aria-current={c.id === page?.id ? "page" : undefined}>
                <span className="crumb-icon">{pageIcon(c)}</span>
                <span className="crumb-title">{pageTitle(c)}</span>
              </button>
            ) : (
              <Dropdown width={260} trigger={(open) => (
                <button className="crumb-more" onClick={open} title={`${hiddenCrumbs.length} more ${hiddenCrumbs.length === 1 ? "page" : "pages"} above this one`}>
                  <Ellipsis size={15} />
                </button>
              )}>
                {(close) => (
                  // The folded pages as a little path: each one sits a step in from the one above it.
                  <div className="menu crumb-path">
                    {hiddenCrumbs.map((h, d) => (
                      <div key={h.id} className="crumb-path-row" style={{ paddingLeft: Math.min(d, 6) * 12 }}>
                        <MenuItem icon={pageIcon(h)} label={pageTitle(h)} onClick={() => (go(h.id), close())} />
                      </div>
                    ))}
                  </div>
                )}
              </Dropdown>
            )}
          </span>
        ))}
        {page?.locked && (
          <span className="chip">
            <Lock size={12} /> Locked
          </span>
        )}
      </nav>
      <span style={{ flex: 1 }} />
      {!online && (
        <span className="chip warn" title="Changes are kept in this tab and will sync when the connection returns.">
          <WifiOff size={12} /> Offline
        </span>
      )}
      {page && (
        <>
          <span className="muted small hide-narrow">Edited {relTime(page.updatedAt)}</span>
          {uniqueHere.length > 0 && (
            <span className="presence">
              {uniqueHere.slice(0, 5).map((u) => (
                <Avatar key={u.id} user={u} size={24} />
              ))}
              {uniqueHere.length > 5 && <span className="muted small">+{uniqueHere.length - 5}</span>}
            </span>
          )}
          <Dropdown align="end" width={360} trigger={(open) => (
            <button className="btn-ghost" onClick={open}>
              Share
            </button>
          )}>
            {() => (
              <div className="share">
                <b>Share this page</b>
                <p className="muted small">Only people in this workspace can open this link. Choose who's in it in Workspace settings → Members.</p>
                <div className="row gap">
                  <input readOnly value={pageUrl(page.id)} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn" onClick={copyLink}>
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              </div>
            )}
          </Dropdown>
          {isDoc && (
            <button className={"icon-btn" + (props.showComments ? " on" : "")} onClick={() => props.setShowComments(!props.showComments)} title="Comments">
              <MessageSquare size={17} />
            </button>
          )}
          <button className={"icon-btn" + (favs.includes(page.id) ? " fav" : "")} onClick={() => toggleFav(page.id)} title="Favorite">
            <Star size={17} fill={favs.includes(page.id) ? "currentColor" : "none"} />
          </button>
          <Dropdown align="end" width={270} trigger={(open) => (
            <button className="icon-btn" onClick={open} title="Page options">
              <Ellipsis size={17} />
            </button>
          )}>
            {(close) => (
              <div className="menu">
                {isDoc && (
                  <>
                    <div className="font-pick">
                      {(["default", "serif", "mono"] as const).map((f) => (
                        <button key={f} className={(page.font ?? "default") === f ? "active" : ""} onClick={() => updatePage(page.id, { font: f }, false)}>
                          <span className={"font-" + f}>Ag</span>
                          {f[0].toUpperCase() + f.slice(1)}
                        </button>
                      ))}
                    </div>
                    <div className="menu-item static">
                      <span className="menu-label">Small text</span>
                      <Toggle on={!!page.smallText} onChange={(v) => updatePage(page.id, { smallText: v || undefined }, false)} />
                    </div>
                  </>
                )}
                <div className="menu-item static">
                  <span className="menu-label">Full width</span>
                  <Toggle on={!!page.fullWidth} onChange={(v) => updatePage(page.id, { fullWidth: v || undefined }, false)} />
                </div>
                <MenuSep />
                <MenuItem
                  icon={page.locked ? <LockOpen size={14} /> : <Lock size={14} />}
                  label={page.locked ? "Unlock page" : "Lock page"}
                  onClick={() => (updatePage(page.id, { locked: page.locked ? undefined : true }, false), close())}
                />
                <MenuItem icon={<Link size={14} />} label="Copy link" onClick={() => (copyPageLink(page), close())} />
                <MenuItem
                  icon={<Copy size={14} />}
                  label="Duplicate"
                  onClick={async () => {
                    close();
                    const id = await duplicatePage(page.id);
                    if (id) {
                      toast(`Duplicated "${pageTitle(page)}"`);
                      go(id);
                    }
                  }}
                />
                {!page.isRow && (
                  <Dropdown side="right" width={260} trigger={(open) => <MenuItem icon={<FolderInput size={14} />} label="Move to" hint="›" onClick={open} />}>
                    {() => <PagePicker exclude={page.id} allowRoot onPick={(t) => (movePage(page.id, t), close())} />}
                  </Dropdown>
                )}
                {isDoc && (
                  <>
                    <MenuSep />
                    <MenuItem
                      icon={<Download size={14} />}
                      label="Export as Markdown"
                      onClick={async () => {
                        const ed = editors.get(page.id);
                        if (ed) download(safeName(page) + ".md", `# ${pageTitle(page)}\n\n` + (await ed.blocksToMarkdownLossy()), "text/markdown");
                        close();
                      }}
                    />
                    <MenuItem
                      icon={<Download size={14} />}
                      label="Export as HTML"
                      onClick={async () => {
                        const ed = editors.get(page.id);
                        if (ed) {
                          const esc = pageTitle(page).replace(/&/g, "&amp;").replace(/</g, "&lt;");
                          download(safeName(page) + ".html", `<!doctype html><meta charset="utf-8"><title>${esc}</title><h1>${esc}</h1>` + (await ed.blocksToHTMLLossy()), "text/html");
                        }
                        close();
                      }}
                    />
                    {!page.locked && <MenuItem icon={<Upload size={14} />} label="Import Markdown…" onClick={() => fileRef.current?.click()} />}
                  </>
                )}
                <MenuSep />
                <MenuItem icon={<Trash2 size={14} />} label="Move to Trash" danger onClick={() => (trashWithUndo(page), close())} />
                <div className="menu-foot">
                  Last edited by {users[page.updatedBy ?? ""]?.name ?? "someone"} · {relTime(page.updatedAt)}
                  <br />
                  Created {new Date(page.createdAt).toLocaleDateString()}
                </div>
              </div>
            )}
          </Dropdown>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              const ed = editors.get(page.id);
              if (!file || !ed) return;
              const blocks = await ed.tryParseMarkdownToBlocks(await file.text());
              const last = ed.document[ed.document.length - 1];
              if (last) ed.insertBlocks(blocks, last, "after");
              else ed.replaceBlocks(ed.document, blocks);
            }}
          />
        </>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- cover + header

function CoverPicker({ page, close }: { page: Page; close: () => void }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (cover: string) => updatePage(page.id, { cover });
  return (
    <div className="cover-picker">
      <MenuLabel>Colors & gradients</MenuLabel>
      <div className="cover-grid">
        {Object.keys(COVERS).map((k) => (
          <button key={k} style={coverStyle(k)} className={page.cover === k ? "active" : ""} onClick={() => set(k)} aria-label="Cover" />
        ))}
      </div>
      <MenuLabel>Image</MenuLabel>
      <div className="row gap pad">
        <input
          placeholder="Paste an image link…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && /^https?:\/\//i.test(url.trim())) (set(url.trim()), close());
          }}
        />
        <button className="btn small" disabled={!/^https?:\/\//i.test(url.trim())} onClick={() => (set(url.trim()), close())}>
          Use
        </button>
      </div>
      <div className="row gap pad">
        <button className="btn-ghost small" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Upload an image
        </button>
        {page.cover && (
          <button className="btn-ghost small" onClick={() => (updatePage(page.id, { cover: undefined }), close())}>
            Remove cover
          </button>
        )}
      </div>
      {err && <div className="error small pad">{err}</div>}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            set(await uploadFile(f));
            close();
          } catch (ex: any) {
            setErr(ex.message);
          }
        }}
      />
    </div>
  );
}

function TitleInput({ page, readOnly, onEnter }: { page: Page; readOnly: boolean; onEnter: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  });
  useEffect(() => {
    // Brand-new pages start with the cursor in the title.
    if (!page.title && Date.now() - page.createdAt < 3000 && !readOnly) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);
  return (
    <textarea
      ref={ref}
      className="page-title"
      rows={1}
      value={page.title}
      placeholder="Untitled"
      readOnly={readOnly}
      onChange={(e) => updatePage(page.id, { title: e.target.value.replace(/\n/g, " ") })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

const DB_STARTERS: [ViewType, string, React.ReactNode][] = [
  ["table", "Table", <Table2 size={14} />],
  ["board", "Board", <Kanban size={14} />],
  ["list", "List", <List size={14} />],
  ["gallery", "Gallery", <GalleryHorizontalEnd size={14} />],
  ["calendar", "Calendar", <CalendarDays size={14} />],
];

// ---------------------------------------------------------------- page

export function PageView(props: { pageId: string; peek?: boolean; theme: "light" | "dark"; showComments?: boolean; onCloseComments?: () => void }) {
  const { pageId } = props;
  const pages = usePages();
  const me = useMe();
  const page = pages[pageId];
  const [empty, setEmpty] = useState(false);
  useEffect(() => setEmpty(false), [pageId]);

  if (!page) {
    return (
      <div className="page-missing">
        <h2>This page doesn't exist</h2>
        <p className="muted">It may have been permanently deleted.</p>
      </div>
    );
  }
  const trashed = isTrashed(pages, pageId);
  const parentDb = page.isRow && page.parentId ? pages[page.parentId] : undefined;
  const locked = !!page.locked || trashed || !!parentDb?.locked;
  const isDb = page.kind === "database";

  return (
    <div className={"page" + (page.fullWidth || (isDb && !props.peek) ? " full" : "") + (page.smallText ? " small-text" : "") + " font-" + (page.font ?? "default")}>
      {trashed && (
        <div className="trash-banner">
          This page is in Trash.
          <button
            className="btn-outline small"
            onClick={() => {
              // Restore the trashed page itself, or the nearest trashed ancestor.
              const top = [...ancestorsOf(pages, pageId), page].find((p) => p.trashed);
              if (top) restorePage(top.id);
            }}
          >
            <CornerUpLeft size={13} /> Restore
          </button>
          {page.trashed && (
            <button
              className="btn-outline small"
              onClick={() => {
                if (confirm("Permanently delete this page and everything inside it? This can't be undone.")) {
                  deleteForever(pageId);
                  go(null);
                }
              }}
            >
              <Trash2 size={13} /> Delete forever
            </button>
          )}
        </div>
      )}

      {page.cover && (
        <div className="cover" style={coverStyle(page.cover)}>
          {!locked && (
            <Dropdown align="end" width={330} trigger={(open) => (
              <button className="cover-btn" onClick={open}>
                Change cover
              </button>
            )}>
              {(close) => <CoverPicker page={page} close={close} />}
            </Dropdown>
          )}
        </div>
      )}

      <div className="page-inner">
        <div className={"page-head" + (page.cover ? " has-cover" : "") + (page.icon ? " has-icon" : "")}>
          {page.icon && (
            <Dropdown trigger={(open) => (
              <button className="page-icon" onClick={(e) => !locked && open(e)} title={locked ? undefined : "Change icon"}>
                {page.icon}
              </button>
            )}>
              {(close) => <EmojiPicker onPick={(icon) => (updatePage(page.id, { icon }), close())} onRemove={() => (updatePage(page.id, { icon: undefined }), close())} />}
            </Dropdown>
          )}
          {!locked && (
            <div className="head-controls">
              {!page.icon && (
                <Dropdown trigger={(open) => (
                  <button className="btn-ghost small muted" onClick={open}>
                    <Smile size={14} /> Add icon
                  </button>
                )}>
                  {(close) => <EmojiPicker onPick={(icon) => (updatePage(page.id, { icon }), close())} />}
                </Dropdown>
              )}
              {!page.cover && (
                <button className="btn-ghost small muted" onClick={() => updatePage(page.id, { cover: "g:" + (1 + Math.floor(Math.random() * 8)) })}>
                  <ImageIcon size={14} /> Add cover
                </button>
              )}
            </div>
          )}
          <TitleInput page={page} readOnly={locked} onEnter={() => editors.get(pageId)?.focus()} />
        </div>

        {page.isRow && <RowProperties rowId={pageId} />}

        {isDb ? (
          <DatabaseView dbId={pageId} />
        ) : me ? (
          <>
            <PageEditor
              pageId={pageId}
              me={me}
              editable={!locked}
              theme={props.theme}
              showComments={!!props.showComments && !props.peek}
              onCloseComments={props.onCloseComments ?? (() => {})}
              onEmptyChange={setEmpty}
            />
            {empty && !locked && !page.isRow && (
              <div className="starters">
                <div className="muted small">Start with a template</div>
                <div className="starter-row">
                  {Object.entries(TEMPLATES)
                    .filter(([k]) => k !== "welcome")
                    .map(([k, t]) => (
                      <button
                        key={k}
                        className="starter"
                        onClick={() => {
                          applyTemplate(pageId, k);
                          if (!page.title) updatePage(pageId, { title: t.label, icon: page.icon ?? t.icon });
                        }}
                      >
                        <span>{t.icon}</span> {t.label}
                      </button>
                    ))}
                </div>
                <div className="muted small">…or turn this page into a database</div>
                <div className="starter-row">
                  {DB_STARTERS.map(([type, label, icon]) => (
                    <button key={type} className="starter" onClick={() => updatePage(pageId, defaultDatabase(type))}>
                      {icon} {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
