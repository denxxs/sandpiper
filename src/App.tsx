import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Search, X } from "lucide-react";
import {
  childrenOf,
  createPage,
  isTrashed,
  pageTitle,
  loadSession,
  seedIfEmpty,
  setPresencePage,
  useAuth,
  useLocal,
  usePages,
  useSynced,
  ancestorsOf,
  takeNotice,
  updateWorkspace,
  useCurrentWorkspace,
  yMeta,
} from "./store";
import { go, openPeek, useRoute, WS_ID } from "./nav";
import { ErrorBoundary, Modal, Toaster, TooltipLayer, useMediaQuery } from "./components/ui";
import { pageIcon, Sidebar } from "./components/Sidebar";
import { PageView, Topbar } from "./components/PageView";
import { LoginScreen } from "./components/Login";
import { SettingsModal, type SettingsTab, type ThemePref } from "./components/Settings";

function useTheme(): ["light" | "dark", ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useLocal<ThemePref>("theme", "system");
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const theme = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, pref, setPref];
}

// ---------------------------------------------------------------- search

/** Marks where the query appears in a title or snippet. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return text;
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0 && out.length < 20; i = lower.indexOf(q, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  out.push(text.slice(at));
  return out;
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const pages = usePages();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [content, setContent] = useState<{ pageId: string; snippet: string }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setContent([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?ws=${WS_ID}&q=${encodeURIComponent(query)}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((d) => setContent(d.results ?? []))
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const live = Object.values(pages).filter((p) => !isTrashed(pages, p.id));
    const byTitle = live
      .filter((p) => !query || pageTitle(p).toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, query ? 30 : 12)
      .map((p) => ({ page: p, snippet: "" }));
    const seen = new Set(byTitle.map((r) => r.page.id));
    const byContent = content
      .filter((c) => pages[c.pageId] && !isTrashed(pages, c.pageId) && !seen.has(c.pageId))
      .map((c) => ({ page: pages[c.pageId], snippet: c.snippet }));
    return [...byTitle, ...byContent];
  }, [pages, q, content]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".search-row.active")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (id: string) => {
    go(id);
    onClose();
  };

  return (
    <Modal onClose={onClose} className="search-modal">
      <div className="search-head">
        <Search size={18} />
        <input
          autoFocus
          placeholder="Search pages and their contents…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter" && results[sel]) pick(results[sel].page.id);
          }}
        />
      </div>
      <div className="search-list" ref={listRef}>
        {!q.trim() && results.length > 0 && <div className="menu-heading">Recently edited</div>}
        {results.map((r, i) => {
          const path = ancestorsOf(pages, r.page.id).map(pageTitle).join(" / ");
          return (
            <div key={r.page.id} className={"search-row" + (i === sel ? " active" : "")} onMouseEnter={() => setSel(i)} onClick={() => pick(r.page.id)}>
              <span className="tree-icon">{pageIcon(r.page)}</span>
              <span className="search-main">
                <span className="search-title">{highlight(pageTitle(r.page), q)}</span>
                {r.snippet ? <span className="search-snippet">{highlight(r.snippet, q)}</span> : path && <span className="search-snippet">{path}</span>}
              </span>
            </div>
          );
        })}
        {results.length === 0 && <div className="muted pad">No results{q.trim() ? ` for "${q.trim()}"` : ""}.</div>}
      </div>
      <div className="search-foot muted small">↑↓ to navigate · Enter to open · Esc to close</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- app

const pageCrashed = (_: Error, retry: () => void) => (
  <div className="page-missing">
    <h2>This page hit a snag</h2>
    <p className="muted">Nothing is lost. Everything on it is still saved.</p>
    <div className="row gap">
      <button className="btn" onClick={retry}>
        Try again
      </button>
      <button className="btn-ghost" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  </div>
);

export function App() {
  const authState = useAuth();
  const synced = useSynced();
  const pages = usePages();
  const route = useRoute();
  const [theme, pref, setPref] = useTheme();
  const [savedSidebarOpen, setSavedSidebarOpen] = useLocal("sidebarOpen", true);
  // On a phone the sidebar floats over the page: it starts closed, has a backdrop, and closes once you pick a page.
  const narrow = useMediaQuery("(max-width: 760px)");
  const [phoneSidebar, setPhoneSidebar] = useState(false);
  const sidebarOpen = narrow ? phoneSidebar : savedSidebarOpen;
  const setSidebarOpen = narrow ? setPhoneSidebar : setSavedSidebarOpen;
  const [sidebarWidth, setSidebarWidth] = useLocal("sidebarWidth", 264);
  const [search, setSearch] = useState(false);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [showComments, setShowComments] = useState(false);
  const [slow, setSlow] = useState(false);
  const [notice, setNotice] = useState(takeNotice);
  const workspace = useCurrentWorkspace();

  useEffect(() => {
    loadSession();
  }, []);

  useEffect(() => {
    if (synced) seedIfEmpty();
    else {
      const t = setTimeout(() => setSlow(true), 4000);
      return () => clearTimeout(t);
    }
  }, [synced]);

  // The workspace that existed before workspaces did kept its name inside its document; copy it into the
  // workspace list once, so the switcher shows it too.
  useEffect(() => {
    if (!synced || !workspace || workspace.name !== null) return;
    updateWorkspace(workspace.id, { name: yMeta.get("name") || "My workspace", icon: yMeta.get("icon") ?? null }).catch(() => {});
  }, [synced, workspace]);

  // Land on the first page when the URL doesn't name one.
  useEffect(() => {
    if (!synced || route.pageId) return;
    const first = childrenOf(pages, null)[0];
    if (first) go(first.id);
  }, [synced, route.pageId, pages]);

  const page = route.pageId ? (pages[route.pageId] ?? null) : null;
  const peek = route.peek && pages[route.peek] ? route.peek : null;

  useEffect(() => {
    if (synced) setPresencePage(peek ?? route.pageId);
  }, [synced, peek, route.pageId]);

  useEffect(() => {
    setPhoneSidebar(false);
  }, [route.pageId, route.peek, narrow]);

  useEffect(() => {
    document.title = page ? `${pageTitle(page)} — Sandpiper` : "Sandpiper";
  }, [page?.title, page?.id]);

  useEffect(() => {
    // Right-click shows Sandpiper's own menus (blocks, rows, pages); the browser's menu stays out of the way,
    // except in text fields, where it's how some people paste.
    const onContext = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContext);
    const offContext = () => window.removeEventListener("contextmenu", onContext);
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        // Leave Ctrl+K to the editor (create link) while text is selected.
        if (!window.getSelection()?.isCollapsed && (e.target as HTMLElement)?.closest?.(".bn-editor")) return;
        e.preventDefault();
        setSearch((s) => !s);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((o: boolean) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      offContext();
    };
  }, [setSidebarOpen]);

  if (authState.status === "loading") {
    return (
      <div className="boot">
        <div className="spinner" />
      </div>
    );
  }
  if (authState.status === "signed-out") return <LoginScreen error={authState.error} />;
  if (!synced) {
    return (
      <div className="boot">
        <div className="spinner" />
        <p>Connecting to your workspace…</p>
        {slow && <p className="muted small">Still trying. Check your internet connection; this page will carry on by itself once it's back.</p>}
      </div>
    );
  }

  return (
    <div className="app">
      <TooltipLayer />
      <Toaster />
      {sidebarOpen && narrow && <div className="side-scrim" onClick={() => setSidebarOpen(false)} aria-hidden />}
      {sidebarOpen && (
        <Sidebar
          activeId={route.pageId}
          onSearch={() => setSearch(true)}
          onSettings={(tab) => setSettings(tab ?? "profile")}
          onCollapse={() => setSidebarOpen(false)}
          width={sidebarWidth}
          setWidth={setSidebarWidth}
        />
      )}
      <main className="main">
        <Topbar page={page} sidebarOpen={sidebarOpen} onOpenSidebar={() => setSidebarOpen(true)} showComments={showComments} setShowComments={setShowComments} />
        {notice && (
          <div className="notice-bar" role="status">
            <span>{notice}</span>
            <button className="icon-btn tiny" onClick={() => setNotice(null)} title="Dismiss" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}
        <div className={"scroll" + (showComments && page?.kind === "page" && !peek ? " with-comments" : "")}>
          {route.pageId ? (
            <ErrorBoundary key={route.pageId} fallback={pageCrashed}>
              <PageView pageId={route.pageId} theme={theme} showComments={showComments} onCloseComments={() => setShowComments(false)} />
            </ErrorBoundary>
          ) : (
            <div className="page-missing">
              <h2>No pages yet</h2>
              <p className="muted">Create your first page to get started.</p>
              <button className="btn" onClick={() => go(createPage({ parentId: null }))}>
                New page
              </button>
            </div>
          )}
        </div>
      </main>
      {peek && route.peekMode === "center" && <div className="peek-scrim" onClick={() => openPeek(null)} aria-hidden />}
      {peek && (
        <aside className={"peek" + (route.peekMode === "center" ? " center" : "")} role={route.peekMode === "center" ? "dialog" : undefined} aria-modal={route.peekMode === "center" || undefined}>
          <div className="peek-bar">
            <button className="icon-btn" onClick={() => go(peek)} title="Open as full page">
              <Maximize2 size={15} />
            </button>
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={() => openPeek(null)} title="Close">
              <X size={16} />
            </button>
          </div>
          <div className="scroll">
            <ErrorBoundary key={peek} fallback={pageCrashed}>
              <PageView pageId={peek} peek theme={theme} />
            </ErrorBoundary>
          </div>
        </aside>
      )}
      {search && <SearchModal onClose={() => setSearch(false)} />}
      {settings && <SettingsModal initialTab={settings} onClose={() => setSettings(null)} pref={pref} setPref={setPref} />}
    </div>
  );
}

