// Code blocks: BlockNote's own, with two changes.
//  - Any language is accepted. The language picker lists a fixed set; a block whose language isn't in it (written
//    by an AI as "js", say) shows the matching entry or "Plain text", and keeps its language for highlighting.
//  - Mermaid, PlantUML and Graphviz code draws its diagram, with Code / Preview / Split as in Notion. Which one a
//    block shows is remembered per browser.
import { createCodeBlockSpec } from "@blocknote/core";
import { CODE_LANGUAGES, codeLanguageId, DIAGRAM_CODE, NOT_HIGHLIGHTED } from "../../shared/blocks";
import { renderDiagram } from "../render";

type View = "code" | "preview" | "split";
const VIEWS: { id: View; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "preview", label: "Preview" },
  { id: "split", label: "Split" },
];
const viewKey = (id: string) => "sandpiper.codeview." + id;
function getView(id: string): View {
  try {
    const v = localStorage.getItem(viewKey(id));
    return v === "code" || v === "split" || v === "preview" ? v : "preview";
  } catch {
    return "preview";
  }
}
function saveView(id: string, v: View) {
  try {
    localStorage.setItem(viewKey(id), v);
  } catch {
    /* the choice just isn't remembered */
  }
}

const textOf = (content: any): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join("") : "";
const isDark = () => document.documentElement.dataset.theme === "dark";

export function notionCodeBlock() {
  const base: any = createCodeBlockSpec({ supportedLanguages: CODE_LANGUAGES, defaultLanguage: "text" });
  const impl = base.implementation;
  return {
    ...base,
    implementation: {
      ...impl,
      meta: {
        ...impl.meta,
        // No highlighting for languages Shiki doesn't know (it would only log an error for each).
        highlight: (b: any) => {
          const l = String(b.props.language ?? "").toLowerCase();
          return !l || NOT_HIGHLIGHTED.has(l) ? undefined : l;
        },
      },
      render(block: any, editor: any) {
        const lang = String(block.props.language ?? "text");
        const listed = codeLanguageId(lang);
        // BlockNote's picker throws for a language it doesn't list, so draw it with the listed one.
        const drawn = impl.render(listed === lang ? block : { ...block, props: { ...block.props, language: listed } }, editor);
        const diagram = Object.hasOwn(DIAGRAM_CODE, lang.toLowerCase()) ? DIAGRAM_CODE[lang.toLowerCase()] : undefined;
        if (!diagram) return drawn;

        const pre = (drawn.dom as DocumentFragment).querySelector?.("pre") as HTMLElement | null;
        const bar = document.createElement("div");
        bar.className = "code-views";
        bar.contentEditable = "false";
        const preview = document.createElement("div");
        preview.className = "code-preview";
        preview.contentEditable = "false";
        const img = document.createElement("img");
        img.className = "diagram-img";
        img.alt = "Diagram";
        img.draggable = false;
        const note = document.createElement("div");
        note.className = "code-preview-note";
        preview.append(img, note);

        let view = getView(block.id);
        const buttons = VIEWS.map((v) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = v.label;
          b.addEventListener("mousedown", (e) => e.preventDefault());
          b.addEventListener("click", () => setView(v.id));
          bar.append(b);
          return { v, b };
        });
        function setView(v: View) {
          view = v;
          saveView(block.id, v);
          for (const { v: x, b } of buttons) b.classList.toggle("on", x.id === v);
          if (pre) pre.style.display = v === "preview" ? "none" : "";
          preview.style.display = v === "code" ? "none" : "";
        }
        // Clicking the picture opens the code beside it, ready to edit.
        preview.addEventListener("click", () => editor.isEditable && view === "preview" && setView("split"));

        let last = "";
        let lastDark = isDark();
        let timer: ReturnType<typeof setTimeout> | null = null;
        let live = true;
        const draw = (force = false) => {
          const current = editor.getBlock(block.id);
          const src = textOf(current?.content ?? block.content);
          const dark = isDark();
          if (!force && src === last && dark === lastDark) return;
          last = src;
          lastDark = dark;
          if (timer) clearTimeout(timer);
          timer = setTimeout(
            () =>
              renderDiagram(diagram, src, dark).then((r) => {
                if (!live) return;
                if (r.url) {
                  img.src = r.url;
                  img.style.width = r.width ? Math.min(r.width, 2000) + "px" : "";
                  img.style.display = "";
                  note.textContent = diagram === "plantuml" ? "Drawn by plantuml.com" : "";
                  note.classList.remove("bad");
                } else {
                  if (!img.getAttribute("src")) img.style.display = "none";
                  note.textContent = r.error ? "This diagram has a mistake: " + r.error : src.trim() ? "" : "Write the diagram's code to see it here.";
                  note.classList.toggle("bad", !!r.error);
                }
              }),
            diagram === "plantuml" ? 600 : 150,
          );
        };
        const off = editor.onChange(() => draw());
        const themeWatch = new MutationObserver(() => draw());
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

        const frag = drawn.dom as DocumentFragment;
        frag.insertBefore(bar, frag.firstChild);
        frag.append(preview);
        setView(view);
        draw(true);
        return {
          ...drawn,
          dom: frag,
          // The bar and the picture are ours: changes to them are not edits to the code.
          ignoreMutation: (m: any) => m.type !== "selection" && !drawn.contentDOM?.contains(m.target),
          destroy: () => {
            live = false;
            if (timer) clearTimeout(timer);
            off?.();
            themeWatch.disconnect();
            drawn.destroy?.();
          },
        };
      },
    },
  };
}
