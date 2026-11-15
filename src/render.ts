// Turning source into pictures: LaTeX (KaTeX), and diagrams (Mermaid, Graphviz, PlantUML). Each library loads the
// first time a page needs it, so pages without formulas or diagrams never download them.
// Diagrams come back as SVG shown through an <img>, so nothing inside a diagram can run as script.

let katexP: Promise<typeof import("katex")> | null = null;
function katex() {
  if (!katexP) {
    katexP = import("katex").then((m) => (m as any).default ?? m);
    import("katex/dist/katex.min.css");
  }
  return katexP;
}

/** LaTeX as HTML (KaTeX), or the reason it can't be drawn. */
export async function renderTex(src: string, display: boolean): Promise<{ html?: string; error?: string }> {
  if (!src.trim()) return { html: "" };
  try {
    const k: any = await katex();
    return { html: k.renderToString(src, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "htmlAndMathml" }) };
  } catch (e: any) {
    return { error: String(e?.message ?? e).replace(/^KaTeX parse error: /, "") };
  }
}

let mermaidP: Promise<any> | null = null;
let mermaidTheme = "";
let seq = 0;
async function mermaid(dark: boolean) {
  if (!mermaidP) mermaidP = import("mermaid").then((m) => m.default);
  const m = await mermaidP;
  const theme = dark ? "dark" : "neutral";
  if (theme !== mermaidTheme) {
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "Inter, system-ui, sans-serif", htmlLabels: false, flowchart: { htmlLabels: false } });
    mermaidTheme = theme;
  }
  return m;
}

let graphvizP: Promise<any> | null = null;
function graphviz() {
  if (!graphvizP) graphvizP = import("@hpcc-js/wasm-graphviz").then((m) => m.Graphviz.load());
  return graphvizP;
}

const svgUrl = (svg: string) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

/** The size an SVG asks for, so the picture keeps it. */
function svgSize(svg: string): { width?: number; height?: number } {
  const vb = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(svg);
  const w = /<svg[^>]*\swidth="([\d.]+)(px|pt)?"/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)(px|pt)?"/.exec(svg);
  const pt = (m: RegExpExecArray | null) => (m ? Number(m[1]) * (m[2] === "pt" ? 4 / 3 : 1) : undefined);
  return { width: pt(w) ?? (vb ? Number(vb[1]) : undefined), height: pt(h) ?? (vb ? Number(vb[2]) : undefined) };
}

export interface Drawn {
  url?: string;
  width?: number;
  height?: number;
  error?: string;
}

/** A diagram as an SVG picture, or the reason it can't be drawn. */
export async function renderDiagram(language: string, src: string, dark: boolean): Promise<Drawn> {
  if (!src.trim()) return {};
  try {
    let svg: string;
    if (language === "mermaid") {
      const m = await mermaid(dark);
      const id = "mmd-" + ++seq;
      try {
        await m.parse(src);
        svg = (await m.render(id, src)).svg;
      } finally {
        document.getElementById(id)?.remove();
        document.getElementById("d" + id)?.remove();
      }
      // Mermaid sizes the picture with width="100%" and a max-width style; give it its natural width instead
      // (one width attribute: a second one would make the SVG invalid as an image).
      const natural = /max-width:\s*([\d.]+)px/.exec(svg)?.[1];
      if (natural) svg = svg.replace(/(<svg[^>]*?)\swidth="[^"]*"/, "$1").replace(/(<svg[^>]*?)\sstyle="[^"]*"/, "$1").replace(/<svg/, `<svg width="${natural}"`);
    } else if (language === "graphviz") {
      const gv = await graphviz();
      svg = gv.dot(dark ? withDarkDot(src) : src);
    } else if (language === "plantuml") {
      const res = await fetch("/api/plantuml", { method: "POST", headers: { "Content-Type": "text/plain" }, body: src });
      const text = await res.text();
      if (!res.ok) return { error: text || "PlantUML couldn't draw this." };
      svg = dark ? text.replace(/<svg/, '<svg style="background:#fff;border-radius:6px"') : text;
    } else return { error: "Unknown diagram language." };
    return { url: svgUrl(svg), ...svgSize(svg) };
  } catch (e: any) {
    const msg = String(e?.message ?? e).split("\n").slice(0, 3).join(" ");
    return { error: msg || "This diagram couldn't be drawn." };
  }
}

/** Light lines and text on a dark page, unless the diagram sets its own colours. */
function withDarkDot(src: string): string {
  if (/\bbgcolor\b|\bfontcolor\b/.test(src)) return src;
  return src.replace(/\{/, '{ bgcolor="transparent"; node [color="#c9c7c1", fontcolor="#e8e6e1"]; edge [color="#c9c7c1", fontcolor="#e8e6e1"]; graph [fontcolor="#e8e6e1", color="#c9c7c1"];');
}
