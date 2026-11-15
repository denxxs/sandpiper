// Markdown in and out of Sandpiper's blocks, for AI assistants that read and write Markdown more easily than block JSON.
//
// Plain Markdown (GitHub flavour) plus a few extensions, so most of what the editor can do survives a round trip:
//   <u>underline</u>
//   <span style="color:red">coloured text</span>          colours: gray brown red orange yellow green blue purple pink
//   <mark>highlight</mark>  <mark style="background:blue">blue highlight</mark>
//   - [ ] to-do   - [x] done
//   > [!💡] callout text                                   any emoji
//   <details><summary>Toggle</summary> … children … </details>
//   [Title](page:<pageId>)     on its own line: a link-to-page block
//   [Title](database:<id>)     on its own line: a database shown inline
//   @[Title](page:<pageId>)    inside text: a mention of a page
//   @[Name](person:<userId>)   inside text: a mention of a person
//   @date(2026-12-01)          inside text: a date (also @date(2026-12-01→2026-12-05), or with THH:MM)
//   $E = mc^2$                 inside text: an equation;  $$ … $$ on lines of their own: a block equation
//   ```mermaid / plantuml / graphviz   a diagram
//   :::columns / :::column / :::        side-by-side columns (":::column 2" makes one twice as wide)
//   [toc]  [breadcrumb]  [bookmark](https://…)  [embed](https://…)   each on its own line
//   <details><summary>## Title</summary> … </details>   a toggle heading
//
// Block colours, alignment and other details Markdown can't say are kept when you read and write blocks instead.
import { Lexer, Marked } from "marked";
import { COLORS } from "./util";
import { codeLanguageId } from "../../shared/blocks";

type Inline = any;
type Block = any;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

const colorName = (raw: string | undefined): string | undefined => {
  const c = (raw ?? "").trim().toLowerCase().replace(/^["']|["']$/g, "");
  return (COLORS as readonly string[]).includes(c) ? c : undefined;
};

/** Colour and highlight from a <span>/<mark> tag's style or data attributes. */
function tagColors(tag: string): { textColor?: string; backgroundColor?: string } {
  const out: { textColor?: string; backgroundColor?: string } = {};
  const style = /style\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
  for (const part of style.split(";")) {
    const [k, v] = part.split(":").map((s) => s?.trim().toLowerCase());
    if (k === "color") out.textColor = colorName(v);
    if (k === "background" || k === "background-color") out.backgroundColor = colorName(v);
  }
  const dc = /data-color\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
  const dh = /data-(?:highlight|bg|background)\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
  if (dc) out.textColor = colorName(dc);
  if (dh) out.backgroundColor = colorName(dh);
  return out;
}

/// ================================================================ Markdown → blocks

const DIAGRAMS: Record<string, string> = { mermaid: "mermaid", plantuml: "plantuml", puml: "plantuml", graphviz: "graphviz", dot: "graphviz" };
const DATE = "\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?";
const startAt = (src: string, re: RegExp) => {
  const m = re.exec(src);
  return m ? m.index + (m[0].startsWith("\n") ? 1 : 0) : undefined;
};

/** Marked, taught Sandpiper's extras: columns, equations and date mentions. */
const parser = new Marked({ gfm: true });
parser.use({
  extensions: [
    {
      name: "columns",
      level: "block",
      start: (src: string) => startAt(src, /(^|\n):::[ \t]*columns/i),
      tokenizer(src: string) {
        const m = /^:::[ \t]*columns[ \t]*\n([\s\S]*?)\n:::[ \t]*(?:\n+|$)/i.exec(src);
        if (!m) return undefined;
        const cols: { width: number; md: string }[] = [];
        let cur: { width: number; lines: string[] } | null = null;
        for (const line of m[1].split("\n")) {
          const head = /^:::[ \t]*column(?:[ \t]+([\d.]+))?[ \t]*$/i.exec(line);
          if (head) {
            if (cur) cols.push({ width: cur.width, md: cur.lines.join("\n") });
            cur = { width: head[1] ? Math.max(0.1, Math.min(10, Number(head[1]))) : 1, lines: [] };
          } else if (cur) cur.lines.push(line);
          else if (line.trim()) cur = { width: 1, lines: [line] };
        }
        if (cur) cols.push({ width: cur.width, md: cur.lines.join("\n") });
        return { type: "columns", raw: m[0], cols };
      },
    },
    {
      name: "blockMath",
      level: "block",
      start: (src: string) => startAt(src, /(^|\n)\$\$/),
      tokenizer(src: string) {
        const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/.exec(src);
        return m ? { type: "blockMath", raw: m[0], text: m[1].trim() } : undefined;
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start: (src: string) => {
        const i = src.indexOf("$");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/.exec(src);
        return m ? { type: "inlineMath", raw: m[0], text: m[1] } : undefined;
      },
    },
    {
      name: "dateMention",
      level: "inline",
      start: (src: string) => {
        const i = src.indexOf("@date(");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = new RegExp(`^@date\\((${DATE})(?:\\s*(?:→|->)\\s*(${DATE}))?\\)`).exec(src);
        return m ? { type: "dateMention", raw: m[0], date: m[1], end: m[2] ?? "" } : undefined;
      },
    },
  ] as any,
});
const OPTIONS = parser.defaults;

/** Parses Markdown into blocks (BlockNote's partial-block format). */
export function markdownToBlocks(md: string): Block[] {
  const tokens = Lexer.lex(String(md ?? "").replace(/\r\n?/g, "\n"), OPTIONS);
  return blocksFrom(tokens);
}

/** Parses a short piece of Markdown into inline content (for one block's text). */
export function markdownToInline(md: string): Inline[] {
  const tokens = Lexer.lexInline(String(md ?? "").replace(/\r\n?/g, "\n"), OPTIONS);
  return inlineFrom(tokens, {});
}

function blocksFrom(tokens: any[]): Block[] {
  const out: Block[] = [];
  // <details> toggles: html tokens open and close them around ordinary Markdown.
  const stack: Block[][] = [out];
  const push = (b: Block) => stack[stack.length - 1].push(b);
  for (const t of tokens) {
    if (t.type === "html" && /^\s*<details/i.test(t.text)) {
      const summary = (/<summary>([\s\S]*?)<\/summary>/i.exec(t.text)?.[1] ?? "").trim();
      const level = /^(#{1,6})\s+/.exec(summary);
      const toggle: Block = level
        ? { type: "heading", props: { level: Math.min(4, level[1].length), isToggleable: true }, content: markdownToInline(summary.slice(level[0].length)), children: [] as Block[] }
        : { type: "toggleListItem", content: markdownToInline(summary), children: [] as Block[] };
      push(toggle);
      const rest = t.text.replace(/^\s*<details[^>]*>/i, "").replace(/<summary>[\s\S]*?<\/summary>/i, "");
      const closes = /<\/details>\s*$/i.test(rest);
      if (!closes) stack.push(toggle.children);
      const inner = rest.replace(/<\/details>\s*$/i, "").trim();
      if (inner) toggle.children.push(...markdownToBlocks(inner));
      continue;
    }
    if (t.type === "html" && /^\s*<\/details>\s*$/i.test(t.text)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    for (const b of blockFrom(t)) push(b);
  }
  return out;
}

function blockFrom(t: any): Block[] {
  switch (t.type) {
    case "space":
      return [];
    case "heading":
      return [{ type: "heading", props: { level: Math.min(4, Math.max(1, t.depth)) }, content: inlineFrom(t.tokens, {}) }];
    case "blockMath":
      return [{ type: "equation", content: t.text }];
    case "columns": {
      const cols = (t.cols as { width: number; md: string }[]).map((c) => {
        const kids = markdownToBlocks(c.md);
        return { width: c.width, children: kids.length ? kids : [{ type: "paragraph" }] };
      });
      if (cols.length < 2) return cols.flatMap((c) => c.children);
      return [{ type: "columnList", children: cols.map((c) => ({ type: "column", props: { width: c.width }, children: c.children })) }];
    }
    case "paragraph":
    case "text": {
      const tokens = (t.tokens ?? []).filter((x: any) => !(x.type === "text" && !x.text.trim()));
      if (tokens.length === 1 && tokens[0].type === "link") {
        const m = /^(page|database):([A-Za-z0-9]{1,40})$/.exec(tokens[0].href);
        if (m?.[1] === "page") return [{ type: "pageLink", props: { pageId: m[2] } }];
        if (m?.[1] === "database") return [{ type: "database", props: { databaseId: m[2] } }];
      }
      const word = String(t.text ?? "").trim().toLowerCase();
      if (word === "[toc]" || word === "[table of contents]") return [{ type: "toc" }];
      if (word === "[breadcrumb]") return [{ type: "breadcrumb" }];
      if (tokens.length === 1 && tokens[0].type === "link" && /^https?:\/\//i.test(tokens[0].href)) {
        const label = String(tokens[0].text ?? "").trim().toLowerCase();
        if (label === "bookmark") return [{ type: "bookmark", props: { link: tokens[0].href } }];
        if (label === "embed") {
          const h = Number(tokens[0].title);
          return [{ type: "embed", props: { link: tokens[0].href, ...(h >= 120 && h <= 1600 ? { height: Math.round(h) } : {}) } }];
        }
      }
      if (tokens.length === 1 && tokens[0].type === "image") {
        return [{ type: "image", props: { url: tokens[0].href, caption: decode(tokens[0].text ?? "") } }];
      }
      // Indentation (a toggle's children are indented) isn't part of the text.
      const unindented = String(t.text ?? "").replace(/^[ \t]+/gm, "");
      const inline = t.type === "paragraph" && unindented !== t.text ? Lexer.lexInline(unindented, OPTIONS) : (t.tokens ?? [{ type: "text", text: t.text }]);
      return [{ type: "paragraph", content: inlineFrom(inline, {}) }];
    }
    case "list":
      return t.items.map((item: any, i: number) => {
        const kind = item.task ? "checkListItem" : t.ordered ? "numberedListItem" : "bulletListItem";
        const block: Block = { type: kind, content: [], children: [] };
        if (item.task) block.props = { checked: !!item.checked };
        else if (t.ordered && i === 0 && Number(t.start) > 1) block.props = { start: Number(t.start) };
        let first = true;
        for (const sub of item.tokens) {
          if (sub.type === "checkbox") continue;
          if (first && (sub.type === "text" || sub.type === "paragraph")) {
            block.content = inlineFrom(sub.tokens ?? [{ type: "text", text: sub.text }], {});
            first = false;
            continue;
          }
          first = false;
          block.children.push(...blockFrom(sub));
        }
        return block;
      });
    case "blockquote": {
      const inner = t.tokens ?? [];
      const head = inner[0];
      const alert = head?.type === "paragraph" ? /^\[!([^\]]{1,16})\]\s*/.exec(head.text) : null;
      if (alert) {
        const word = alert[1].trim();
        const emoji = { NOTE: "ℹ️", TIP: "💡", IMPORTANT: "❗", WARNING: "⚠️", CAUTION: "🛑" }[word.toUpperCase()] ?? word;
        const content = markdownToInline(head.text.slice(alert[0].length));
        const children = inner.slice(1).flatMap(blockFrom);
        return [{ type: "callout", props: { emoji }, content, ...(children.length ? { children } : {}) }];
      }
      if (head?.type === "paragraph") {
        const children = inner.slice(1).flatMap(blockFrom);
        return [{ type: "quote", content: inlineFrom(head.tokens, {}), ...(children.length ? { children } : {}) }];
      }
      return inner.flatMap(blockFrom);
    }
    case "code": {
      const lang = (t.lang || "text").split(/\s/)[0].toLowerCase();
      if (DIAGRAMS[lang]) return [{ type: "diagram", props: { language: DIAGRAMS[lang] }, content: t.text }];
      // A known alias (js, py) is stored under the name the language picker lists.
      const id = codeLanguageId(lang);
      return [{ type: "codeBlock", props: { language: id !== "text" ? id : lang }, content: t.text }];
    }
    case "hr":
      return [{ type: "divider" }];
    case "table": {
      const row = (cells: any[]) => ({ cells: cells.map((c) => inlineFrom(c.tokens, {})) });
      return [{ type: "table", content: { type: "tableContent", headerRows: 1, rows: [row(t.header), ...t.rows.map(row)] } }];
    }
    case "html": {
      const text = t.text.replace(/<[^>]+>/g, "").trim();
      return text ? [{ type: "paragraph", content: [{ type: "text", text: decode(text), styles: {} }] }] : [];
    }
    default:
      return t.text ? [{ type: "paragraph", content: [{ type: "text", text: decode(String(t.text)), styles: {} }] }] : [];
  }
}

/** Inline tokens to BlockNote inline content, carrying styles down. */
function inlineFrom(tokens: any[] = [], styles: Record<string, any>): Inline[] {
  const out: Inline[] = [];
  // Styles opened by inline HTML tags (<u>, <span style>, <mark>) apply until their closing tag.
  const open: { tag: string; styles: Record<string, any> }[] = [];
  const current = () => Object.assign({}, styles, ...open.map((o) => o.styles));
  const text = (s: string, st: Record<string, any>) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last?.type === "text" && JSON.stringify(last.styles) === JSON.stringify(st)) last.text += s;
    else out.push({ type: "text", text: s, styles: { ...st } });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const st = current();
    switch (t.type) {
      case "text":
        if (t.tokens?.length) out.push(...inlineFrom(t.tokens, st));
        else text(decode(t.text), st);
        break;
      case "escape":
        text(t.text, st);
        break;
      case "strong":
        out.push(...inlineFrom(t.tokens, { ...st, bold: true }));
        break;
      case "em":
        out.push(...inlineFrom(t.tokens, { ...st, italic: true }));
        break;
      case "del":
        out.push(...inlineFrom(t.tokens, { ...st, strike: true }));
        break;
      case "codespan":
        text(decode(t.text), { ...st, code: true });
        break;
      case "br":
        text("\n", st);
        break;
      case "inlineMath":
        out.push({ type: "inlineEquation", content: t.text });
        break;
      case "dateMention":
        out.push({ type: "dateMention", props: { date: t.date, end: t.end } });
        break;
      case "link": {
        const person = /^person:([A-Za-z0-9_-]{1,64})$/.exec(t.href);
        if (person) {
          const last = out[out.length - 1];
          if (last?.type === "text" && last.text.endsWith("@")) {
            last.text = last.text.slice(0, -1);
            if (!last.text) out.pop();
          }
          out.push({ type: "personMention", props: { userId: person[1] } });
          break;
        }
        const page = /^page:([A-Za-z0-9]{1,40})$/.exec(t.href);
        if (page) {
          // "@[Title](page:id)" is a mention; drop the "@" written before it.
          const last = out[out.length - 1];
          if (last?.type === "text" && last.text.endsWith("@")) {
            last.text = last.text.slice(0, -1);
            if (!last.text) out.pop();
          }
          out.push({ type: "mention", props: { pageId: page[1] } });
          break;
        }
        const content = inlineFrom(t.tokens, st).filter((c) => c.type === "text");
        out.push({ type: "link", href: t.href, content: content.length ? content : [{ type: "text", text: t.href, styles: st }] });
        break;
      }
      case "image":
        text(t.text || t.href, st);
        break;
      case "html": {
        const tag = t.text.trim();
        const close = /^<\/(\w+)/.exec(tag);
        if (close) {
          const at = open.map((o) => o.tag).lastIndexOf(close[1].toLowerCase());
          if (at >= 0) open.splice(at, 1);
          break;
        }
        const name = /^<(\w+)/.exec(tag)?.[1]?.toLowerCase();
        if (name === "br") text("\n", st);
        else if (name === "u" || name === "ins") open.push({ tag: name, styles: { underline: true } });
        else if (name === "s" || name === "del" || name === "strike") open.push({ tag: name, styles: { strike: true } });
        else if (name === "b" || name === "strong") open.push({ tag: name, styles: { bold: true } });
        else if (name === "i" || name === "em") open.push({ tag: name, styles: { italic: true } });
        else if (name === "code") open.push({ tag: name, styles: { code: true } });
        else if (name === "mark") open.push({ tag: name, styles: { backgroundColor: "yellow", ...tagColors(tag) } });
        else if (name === "span" || name === "font") open.push({ tag: name, styles: tagColors(tag) });
        break;
      }
      default:
        if (t.text) text(decode(String(t.text)), st);
    }
  }
  return out;
}

// ================================================================ blocks → Markdown

const escapeText = (s: string) => s.replace(/([\\*_`~\[\]<$])/g, "\\$1");

/** Inline content as Markdown. Mentions are written as @[](page:id); the caller fills in titles. */
export function inlineToMarkdown(content: any): string {
  if (typeof content === "string") return escapeText(content);
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c.type === "text") out += styled(c.text, c.styles ?? {});
    else if (c.type === "link") out += `[${(c.content ?? []).map((x: any) => styled(x.text, x.styles ?? {})).join("")}](${c.href})`;
    else if (c.type === "mention") out += `@[](page:${c.props?.pageId ?? ""})`;
    else if (c.type === "personMention") out += `@[](person:${c.props?.userId ?? ""})`;
    else if (c.type === "dateMention") out += `@date(${c.props?.date ?? ""}${c.props?.end ? "→" + c.props.end : ""})`;
    else if (c.type === "inlineEquation") out += "$" + (typeof c.content === "string" ? c.content : plainText(c.content)) + "$";
  }
  return out;
}

function styled(raw: string, s: Record<string, any>): string {
  if (!raw) return "";
  // Keep surrounding spaces outside the markers, which Markdown needs to see them.
  const lead = /^\s*/.exec(raw)![0];
  const trail = /\s*$/.exec(raw.slice(lead.length))![0];
  const core = raw.slice(lead.length, raw.length - trail.length);
  if (!core) return raw;
  let t = s.code ? "`" + core.replace(/`/g, "ˋ") + "`" : escapeText(core).replace(/\n/g, "<br>");
  if (s.bold) t = `**${t}**`;
  if (s.italic) t = `*${t}*`;
  if (s.strike) t = `~~${t}~~`;
  if (s.underline) t = `<u>${t}</u>`;
  if (s.textColor && s.textColor !== "default") t = `<span style="color:${s.textColor}">${t}</span>`;
  if (s.backgroundColor && s.backgroundColor !== "default") t = s.backgroundColor === "yellow" ? `<mark>${t}</mark>` : `<mark style="background:${s.backgroundColor}">${t}</mark>`;
  return lead + t + trail;
}

/** Blocks as Markdown (lossy for colours and alignment of whole blocks). */
export function blocksToMarkdown(blocks: any[], indent = ""): string {
  const lines: string[] = [];
  let number = 0;
  const trimmed = [...blocks];
  while (trimmed.length && isEmptyParagraph(trimmed[trimmed.length - 1])) trimmed.pop();
  let prevList = false;
  for (const b of trimmed) {
    const listItem = /ListItem$/.test(b.type) && b.type !== "toggleListItem";
    // A blank line ends a list, or the next block would read as part of its last item.
    if (prevList && !listItem) lines.push("");
    prevList = listItem;
    number = b.type === "numberedListItem" ? (number === 0 && Number(b.props?.start) > 1 ? Number(b.props.start) : number + 1) : 0;
    const text = inlineToMarkdown(b.content);
    // Nested blocks line up with the item's text ("1. " is three characters wide).
    const pad = b.type === "numberedListItem" ? " ".repeat(String(number).length + 2) : "  ";
    const kids = b.children?.length ? blocksToMarkdown(b.children, indent + pad) : "";
    let line: string;
    switch (b.type) {
      case "heading":
        if (b.props?.isToggleable) {
          lines.push(`${indent}<details><summary>${"#".repeat(b.props?.level ?? 1)} ${text}</summary>`, "");
          if (kids) lines.push(kids, "");
          lines.push(`${indent}</details>`, "");
          continue;
        }
        line = `${"#".repeat(b.props?.level ?? 1)} ${text}`;
        break;
      case "equation":
        lines.push(`${indent}$$`, ...plainText(b.content).split("\n").map((l: string) => indent + l), `${indent}$$`, "");
        continue;
      case "diagram":
        lines.push(indent + "```" + (b.props?.language ?? "mermaid"), ...plainText(b.content).split("\n").map((l: string) => indent + l), indent + "```", "");
        continue;
      case "columnList":
        lines.push(`${indent}:::columns`);
        for (const col of b.children ?? []) {
          const w = Number(col.props?.width ?? 1);
          lines.push(`${indent}:::column${w !== 1 ? " " + +w.toFixed(2) : ""}`, blocksToMarkdown(col.children ?? [], indent).replace(/\n+$/, ""));
        }
        lines.push(`${indent}:::`, "");
        continue;
      case "toc":
        line = "[toc]";
        break;
      case "breadcrumb":
        line = "[breadcrumb]";
        break;
      case "bookmark":
        line = `[bookmark](${b.props?.link ?? ""})`;
        break;
      case "embed":
        line = `[embed](${b.props?.link ?? ""}${b.props?.height && b.props.height !== 400 ? ` "${b.props.height}"` : ""})`;
        break;
      case "bulletListItem":
        line = `- ${text}`;
        break;
      case "numberedListItem":
        line = `${number}. ${text}`;
        break;
      case "checkListItem":
        line = `- [${b.props?.checked ? "x" : " "}] ${text}`;
        break;
      case "toggleListItem":
        lines.push(`${indent}<details><summary>${text}</summary>`, "");
        if (kids) lines.push(kids, "");
        lines.push(`${indent}</details>`, "");
        continue;
      case "quote":
        line = `> ${text}`;
        break;
      case "callout":
        line = `> [!${b.props?.emoji || "💡"}] ${text}`;
        break;
      case "codeBlock": {
        const code = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
        lines.push(`${indent}\`\`\`${b.props?.language && b.props.language !== "text" ? b.props.language : ""}`, ...code.split("\n").map((l: string) => indent + l), `${indent}\`\`\``, "");
        continue;
      }
      case "divider":
        line = "---";
        break;
      case "table": {
        const rows: any[] = b.content?.rows ?? [];
        const cell = (c: any) => inlineToMarkdown(Array.isArray(c) ? c : (c?.content ?? [])).replace(/\|/g, "\\|") || " ";
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.cells.length));
          const fmt = (r: any) => `| ${Array.from({ length: width }, (_, i) => cell(r.cells[i])).join(" | ")} |`;
          lines.push(indent + fmt(rows[0]), indent + `|${" --- |".repeat(width)}`, ...rows.slice(1).map((r) => indent + fmt(r)), "");
        }
        continue;
      }
      case "image":
        line = `![${escapeText(b.props?.caption || b.props?.name || "")}](${b.props?.url ?? ""})`;
        break;
      case "video":
      case "audio":
      case "file":
        line = `[${escapeText(b.props?.name || b.props?.caption || b.type)}](${b.props?.url ?? ""})`;
        break;
      case "pageLink":
        line = `[](page:${b.props?.pageId ?? ""})`;
        break;
      case "database":
        line = `[](database:${b.props?.databaseId ?? ""})`;
        break;
      default:
        line = text;
    }
    lines.push(indent + line);
    if (kids) lines.push(kids);
    if (!listItem) lines.push("");
  }
  // Lists stay tight; a blank line after the last item separates it from what follows.
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return indent ? out.replace(/\n+$/, "") : out.trim() + "\n";
}

function isEmptyParagraph(b: any) {
  return b?.type === "paragraph" && (!b.content || (Array.isArray(b.content) && b.content.length === 0)) && !b.children?.length;
}

/** Plain text of inline content (for searching, anchors, previews). */
export function plainText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c.type === "text"
            ? c.text
            : c.type === "link"
              ? plainText(c.content)
              : c.type === "inlineEquation"
                ? plainText(c.content)
                : c.type === "dateMention"
                  ? (c.props?.date ?? "")
                  : "",
      )
      .join("");
  if (content?.type === "tableContent") return (content.rows ?? []).map((r: any) => r.cells.map((c: any) => plainText(Array.isArray(c) ? c : c?.content)).join(" | ")).join("\n");
  return "";
}
