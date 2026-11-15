// Custom blocks and inline content, drawn in React. Their configuration (types, props, content) lives in
// shared/blocks.ts so the server reads and writes the same structure.
import { useEffect, useRef, useState } from "react";
import { plainContentToString } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec, SourceBlockWithPreview, SourceInlineContentWithPreview, useEditorChange } from "@blocknote/react";
import { ChevronRight, ExternalLink, Globe, Link2, ListTree, Network } from "lucide-react";
import { BLOCKS, DIAGRAM_LANGUAGES, INLINES } from "../../shared/blocks";
import { ancestorsOf, pageTitle, usePages, useUsers } from "../store";
import { go } from "../nav";
import { renderDiagram, renderTex, Drawn } from "../render";
import { pageIcon } from "./Sidebar";
import { Popover } from "./ui";

/** Which page an editor shows (Editor.tsx fills this in). */
export const editorPage = new WeakMap<object, string>();

const isDark = () => document.documentElement.dataset.theme === "dark";

/** Scrolls to a block and flashes it, for links to blocks and the table of contents. */
export function flashBlock(id: string): boolean {
  const sel = `[data-id="${CSS.escape(id)}"]`;
  const el = (document.querySelector(`.bn-editor [data-node-type="blockOuter"]${sel}`) ?? document.querySelector(`.bn-editor ${sel}`)) as HTMLElement | null;
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // The editor owns the block's element (and resets its classes), so the highlight is a layer of its own on top.
  const content = (el.querySelector(".bn-block-content") as HTMLElement | null) ?? el;
  const mark = document.createElement("div");
  mark.className = "block-flash";
  document.body.appendChild(mark);
  let frames = 0;
  const place = () => {
    const r = content.getBoundingClientRect();
    Object.assign(mark.style, { left: r.left - 4 + "px", top: r.top - 2 + "px", width: r.width + 8 + "px", height: r.height + 4 + "px" });
    if (++frames < 90) requestAnimationFrame(place);
  };
  place();
  setTimeout(() => mark.remove(), 2400);
  return true;
}

// ---------------------------------------------------------------- equations

function useTex(src: string, display: boolean) {
  const [state, setState] = useState<{ html?: string; error?: string; last?: string }>({});
  useEffect(() => {
    let live = true;
    renderTex(src, display).then((r) => live && setState((s) => ({ ...r, last: r.html ?? s.last })));
    return () => {
      live = false;
    };
  }, [src, display]);
  return state;
}

const Tex = ({ html, display }: { html?: string; display?: boolean }) => (html ? <span className={display ? "tex tex-block" : "tex"} dangerouslySetInnerHTML={{ __html: html }} /> : null);

export const EquationBlock = createReactBlockSpec(BLOCKS.equation as any, {
  meta: { hasPreview: true, code: true },
  render: (props: any) => {
    const src = plainContentToString(props.block.content ?? []);
    const tex = useTex(src, true);
    return (
      <SourceBlockWithPreview
        block={props.block}
        editor={props.editor}
        contentRef={props.contentRef}
        source={src}
        preview={<Tex html={tex.error ? tex.last : tex.html} display />}
        error={tex.error}
        emptySourcePlaceholder="Add a TeX equation"
        errorPreview="This equation has a mistake"
        sourcePlaceholder="e.g. E = mc^2"
      />
    );
  },
});

export const InlineEquation = createReactInlineContentSpec(INLINES.inlineEquation as any, {
  meta: { hasPreview: true, code: true },
  render: (props: any) => {
    const src = String(props.inlineContent.content ?? "");
    const tex = useTex(src, false);
    return (
      <SourceInlineContentWithPreview
        editor={props.editor}
        node={props.node}
        getPos={props.getPos}
        contentRef={props.contentRef}
        source={src}
        preview={<Tex html={tex.error ? tex.last : tex.html} />}
        error={tex.error}
        emptySourcePlaceholder="New equation"
        sourcePlaceholder="e.g. x^2"
      />
    );
  },
} as any);

// ---------------------------------------------------------------- diagrams

const DIAGRAM_NAME: Record<string, string> = { mermaid: "Mermaid", plantuml: "PlantUML", graphviz: "Graphviz" };
const DIAGRAM_HINT: Record<string, string> = {
  mermaid: "graph TD; A-->B",
  plantuml: "Alice -> Bob: Hello",
  graphviz: "digraph { a -> b }",
};

function useDiagram(language: string, src: string) {
  const [state, setState] = useState<Drawn & { last?: Drawn; busy?: boolean }>({});
  const [dark, setDark] = useState(isDark());
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    // PlantUML goes to a server; don't send every keystroke.
    const t = setTimeout(() => renderDiagram(language, src, dark).then((r) => live && setState((s) => ({ ...r, last: r.url ? r : s.last, busy: false }))), language === "plantuml" ? 600 : 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [language, src, dark]);
  return state;
}

function DiagramPicture({ d }: { d?: Drawn }) {
  if (!d?.url) return null;
  return <img className="diagram-img" src={d.url} alt="Diagram" style={{ width: d.width ? Math.min(d.width, 2000) : undefined }} draggable={false} />;
}

export const DiagramBlock = createReactBlockSpec(BLOCKS.diagram as any, {
  meta: { hasPreview: true, code: true, highlight: (b: any) => (b.props.language === "mermaid" ? "mermaid" : undefined) },
  render: (props: any) => {
    const { block, editor } = props;
    const src = plainContentToString(block.content ?? []);
    const lang = block.props.language as string;
    const d = useDiagram(lang, src);
    return (
      <div className="diagram">
        <div className="diagram-bar" contentEditable={false}>
          <Network size={13} />
          <select
            value={lang}
            disabled={!editor.isEditable}
            onChange={(e) => editor.updateBlock(block, { props: { language: e.target.value } })}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Diagram language"
          >
            {DIAGRAM_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {DIAGRAM_NAME[l]}
              </option>
            ))}
          </select>
          {lang === "plantuml" && <span className="muted small">Drawn by plantuml.com</span>}
        </div>
        <SourceBlockWithPreview
          block={block}
          editor={editor}
          contentRef={props.contentRef}
          source={src}
          preview={<DiagramPicture d={d.error ? d.last : d} />}
          error={d.error}
          emptySourcePlaceholder={`Add a ${DIAGRAM_NAME[lang]} diagram`}
          errorPreview="This diagram has a mistake"
          sourcePlaceholder={DIAGRAM_HINT[lang]}
        />
      </div>
    );
  },
});

// ---------------------------------------------------------------- table of contents, breadcrumb

function useHeadings(editor: any) {
  const read = () => {
    const out: { id: string; level: number; text: string }[] = [];
    const walk = (blocks: any[], depth: number) => {
      for (const b of blocks) {
        if (b.type === "heading") {
          const text = (Array.isArray(b.content) ? b.content : []).map((c: any) => c.text ?? (c.content ? c.content.map((x: any) => x.text).join("") : "")).join("");
          out.push({ id: b.id, level: b.props.level, text });
        }
        if (b.children?.length && depth < 6) walk(b.children, depth + 1);
      }
    };
    walk(editor.document, 0);
    return out;
  };
  const [list, setList] = useState(read);
  useEditorChange(() => setList(read()), editor);
  return list;
}

export const TocBlock = createReactBlockSpec(BLOCKS.toc as any, {
  render: (props: any) => {
    const heads = useHeadings(props.editor);
    const min = Math.min(4, ...heads.map((h) => h.level));
    return (
      <nav className="toc" contentEditable={false} aria-label="Table of contents">
        {heads.length === 0 ? (
          <span className="muted small">
            <ListTree size={14} /> Add headings to this page and they'll be listed here.
          </span>
        ) : (
          heads.map((h) => (
            <a key={h.id} className={"toc-item toc-l" + (h.level - min)} href={"#"} onClick={(e) => (e.preventDefault(), flashBlock(h.id))}>
              {h.text || "Untitled"}
            </a>
          ))
        )}
      </nav>
    );
  },
});

export const BreadcrumbBlock = createReactBlockSpec(BLOCKS.breadcrumb as any, {
  render: (props: any) => {
    const pages = usePages();
    const id = editorPage.get(props.editor);
    const trail = id && pages[id] ? [...ancestorsOf(pages, id), pages[id]] : [];
    return (
      <nav className="breadcrumb-block" contentEditable={false} aria-label="Breadcrumb">
        {trail.map((p, i) => (
          <span key={p.id} className="bc-item">
            {i > 0 && <ChevronRight size={13} className="muted" />}
            <a href={"#/" + p.id} onClick={(e) => (e.preventDefault(), go(p.id))}>
              <span className="bc-icon">{pageIcon(p)}</span> {pageTitle(p)}
            </a>
          </span>
        ))}
      </nav>
    );
  },
});

// ---------------------------------------------------------------- bookmarks and embeds

function UrlInput({ placeholder, onSubmit, editable }: { placeholder: string; onSubmit: (url: string) => void; editable: boolean }) {
  const [v, setV] = useState("");
  const [bad, setBad] = useState(false);
  const submit = () => {
    let url = v.trim();
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      onSubmit(u.toString());
    } catch {
      setBad(true);
    }
  };
  return (
    <div className="url-input" contentEditable={false}>
      <Link2 size={16} className="muted" />
      <input
        value={v}
        placeholder={placeholder}
        disabled={!editable}
        onChange={(e) => (setV(e.target.value), setBad(false))}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => e.stopPropagation()}
      />
      <button className="btn small" disabled={!editable || !v.trim()} onClick={submit}>
        {placeholder.startsWith("Paste a link to embed") ? "Embed" : "Add"}
      </button>
      {bad && <span className="small danger-text">That isn't a web address.</span>}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export const BookmarkBlock = createReactBlockSpec(BLOCKS.bookmark as any, {
  render: (props: any) => {
    const { block, editor } = props;
    const p = block.props;
    const fetched = useRef(false);
    useEffect(() => {
      if (!p.link || p.title || fetched.current || !editor.isEditable) return;
      fetched.current = true;
      fetch("/api/unfurl?url=" + encodeURIComponent(p.link))
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
          if (!m) return;
          const cur = editor.getBlock(block.id);
          if (cur && !cur.props.title) editor.updateBlock(block.id, { props: { title: m.title || hostOf(p.link), description: m.description ?? "", image: m.image ?? "", icon: m.icon ?? "" } });
        })
        .catch(() => {});
    }, [p.link, p.title, block.id, editor]);
    if (!p.link) return <UrlInput placeholder="Paste a link to make a bookmark…" editable={editor.isEditable} onSubmit={(url) => editor.updateBlock(block, { props: { link: url } })} />;
    return (
      <a className="bookmark" href={p.link} target="_blank" rel="noreferrer noopener" contentEditable={false}>
        <span className="bookmark-text">
          <span className="bookmark-title">{p.title || hostOf(p.link)}</span>
          {p.description && <span className="bookmark-desc">{p.description}</span>}
          <span className="bookmark-url">
            {p.icon ? <img src={p.icon} alt="" width={14} height={14} referrerPolicy="no-referrer" /> : <Globe size={13} />} {p.link}
          </span>
        </span>
        {p.image && <img className="bookmark-image" src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      </a>
    );
  },
});

/** The address to put in an iframe for a link: the provider's embed page where there is one. */
export function embedUrl(raw: string): { src: string; provider: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { src: raw, provider: "Web page" };
  }
  const h = u.hostname.replace(/^www\.|^m\./, "");
  if (h === "youtube.com" || h === "youtu.be" || h === "music.youtube.com") {
    const id = h === "youtu.be" ? u.pathname.slice(1) : (u.searchParams.get("v") ?? /\/(?:shorts|embed|live)\/([^/?]+)/.exec(u.pathname)?.[1]);
    if (id) return { src: `https://www.youtube-nocookie.com/embed/${id}${u.searchParams.get("t") ? "?start=" + parseInt(u.searchParams.get("t")!) : ""}`, provider: "YouTube" };
  }
  if (h === "vimeo.com" && /^\/\d+/.test(u.pathname)) return { src: `https://player.vimeo.com/video${u.pathname.match(/^\/\d+/)![0]}`, provider: "Vimeo" };
  if (h === "loom.com" && u.pathname.startsWith("/share/")) return { src: `https://www.loom.com/embed/${u.pathname.slice(7)}`, provider: "Loom" };
  if (h === "open.spotify.com" && !u.pathname.startsWith("/embed")) return { src: `https://open.spotify.com/embed${u.pathname}`, provider: "Spotify" };
  if (h === "figma.com") return { src: `https://www.figma.com/embed?embed_host=sandpiper&url=${encodeURIComponent(raw)}`, provider: "Figma" };
  if (h === "codepen.io" && u.pathname.includes("/pen/")) return { src: `https://codepen.io${u.pathname.replace("/pen/", "/embed/")}?default-tab=result`, provider: "CodePen" };
  if (h === "docs.google.com") return { src: raw.replace(/\/(edit|view)([?#].*)?$/, "/preview"), provider: "Google Docs" };
  if (h === "drive.google.com" && /\/file\/d\//.test(u.pathname)) return { src: raw.replace(/\/(view|edit)([?#].*)?$/, "/preview"), provider: "Google Drive" };
  if ((h === "google.com" || h.endsWith(".google.com")) && u.pathname.startsWith("/maps")) {
    const place = /\/place\/([^/]+)/.exec(u.pathname)?.[1];
    const at = /@(-?[\d.]+),(-?[\d.]+)/.exec(u.pathname);
    const q = place ? decodeURIComponent(place.replace(/\+/g, " ")) : at ? `${at[1]},${at[2]}` : (u.searchParams.get("q") ?? "");
    return { src: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`, provider: "Google Maps" };
  }
  if (h === "openstreetmap.org") return { src: raw, provider: "OpenStreetMap" };
  return { src: raw, provider: hostOf(raw) };
}

export const EmbedBlock = createReactBlockSpec(BLOCKS.embed as any, {
  render: (props: any) => {
    const { block, editor } = props;
    const [h, setH] = useState<number | null>(null);
    const height = h ?? Number(block.props.height) ?? 400;
    if (!block.props.link) return <UrlInput placeholder="Paste a link to embed (YouTube, Maps, Figma, Loom, Spotify, Google Docs, any page)…" editable={editor.isEditable} onSubmit={(url) => editor.updateBlock(block, { props: { link: url } })} />;
    const { src, provider } = embedUrl(block.props.link);
    const startResize = (e: React.PointerEvent) => {
      if (!editor.isEditable) return;
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = height;
      let latest = h0;
      const move = (ev: PointerEvent) => setH((latest = Math.max(120, Math.min(1600, h0 + ev.clientY - y0))));
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        editor.updateBlock(block, { props: { height: Math.round(latest) } });
        setH(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    return (
      <div className="embed" contentEditable={false}>
        <iframe
          src={src}
          title={provider}
          style={{ height }}
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation allow-popups-to-escape-sandbox"
          referrerPolicy="strict-origin-when-cross-origin"
        />
        <div className="embed-foot">
          <span className="muted small">{provider}</span>
          <a className="muted small" href={block.props.link} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={12} /> Open
          </a>
        </div>
        {editor.isEditable && <div className="embed-resize" onPointerDown={startResize} title="Drag to resize" />}
      </div>
    );
  },
});

// ---------------------------------------------------------------- columns

export const ColumnListBlock = createReactBlockSpec(BLOCKS.columnList as any, {
  renderFrame: (props: any) => <div className="bn-columns" ref={props.slotRef} />,
} as any);

export const ColumnBlock = createReactBlockSpec(BLOCKS.column as any, {
  renderFrame: (props: any) => {
    const { block, editor } = props;
    const ref = useRef<HTMLDivElement>(null);
    const startResize = (e: React.PointerEvent) => {
      if (!editor.isEditable) return;
      e.preventDefault();
      e.stopPropagation();
      const parent = editor.getParentBlock(block);
      const cols = parent?.children ?? [];
      const i = cols.findIndex((c: any) => c.id === block.id);
      const next = cols[i + 1];
      const el = ref.current;
      const nextEl = el?.nextElementSibling as HTMLElement | null;
      if (!next || !el || !nextEl) return;
      const x0 = e.clientX;
      const w0 = el.getBoundingClientRect().width;
      const w1 = nextEl.getBoundingClientRect().width;
      const total = Number(block.props.width) + Number(next.props.width);
      let a = Number(block.props.width);
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - x0;
        const left = Math.max(60, Math.min(w0 + w1 - 60, w0 + dx));
        a = (left / (w0 + w1)) * total;
        el.style.flexGrow = String(a);
        nextEl.style.flexGrow = String(total - a);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        editor.transact(() => {
          editor.updateBlock(block, { props: { width: +a.toFixed(3) } });
          editor.updateBlock(next, { props: { width: +(total - a).toFixed(3) } });
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    return (
      <div className="bn-column" ref={ref} style={{ flexGrow: Number(block.props.width) || 1 }}>
        <div className="bn-column-slot" ref={props.slotRef} />
        {editor.isEditable && <div className="bn-column-resize" contentEditable={false} onPointerDown={startResize} aria-hidden />}
      </div>
    );
  },
} as any);

// ---------------------------------------------------------------- inline: dates and people

function fmtDay(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = Math.round((date.getTime() - t0) / 86_400_000);
  const rel = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : null;
  const time = /T(\d{2}):(\d{2})/.exec(s);
  const day = rel ?? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  return time ? `${day} ${new Date(2000, 0, 1, +time[1], +time[2]).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : day;
}

export const DateMention = createReactInlineContentSpec(INLINES.dateMention as any, {
  render: (props: any) => {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const { date, end } = props.inlineContent.props;
    return (
      <>
        <span
          className="date-mention"
          contentEditable={false}
          onClick={(e) => props.editor.isEditable && setAnchor(e.currentTarget)}
          title={date + (end ? " → " + end : "")}
        >
          @{fmtDay(date)}
          {end ? " → " + fmtDay(end) : ""}
        </span>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)} width={240}>
            <div className="date-editor" onKeyDown={(e) => e.stopPropagation()}>
              <input type="date" autoFocus defaultValue={date.slice(0, 10)} onChange={(e) => e.target.value && props.updateInlineContent({ type: "dateMention", props: { date: e.target.value, end } })} />
            </div>
          </Popover>
        )}
      </>
    );
  },
} as any);

export const PersonMention = createReactInlineContentSpec(INLINES.personMention as any, {
  render: (props: any) => {
    const users = useUsers();
    const u = users[props.inlineContent.props.userId];
    return (
      <span className="person-mention" contentEditable={false}>
        @{u?.name ?? "Someone"}
      </span>
    );
  },
} as any);

