// The custom blocks and inline content Sandpiper's editor has beyond BlockNote's own, as plain configuration: type
// names, props, what content each holds, and the layout blocks behind columns. The app (src/components/Editor.tsx)
// draws them; the server (worker/mcp/editor.ts) reads and writes them for AI apps. Both build their schema from
// this file, so a page written by one always reads in the other.

const colors = { textColor: { default: "default" as const }, backgroundColor: { default: "default" as const } };

export const DIAGRAM_LANGUAGES = ["mermaid", "plantuml", "graphviz"] as const;
export type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number];

/** Blocks: config for createBlockSpec / createReactBlockSpec. */
export const BLOCKS = {
  callout: { type: "callout", propSchema: { emoji: { default: "💡" }, ...colors }, content: "inline" },
  pageLink: { type: "pageLink", propSchema: { pageId: { default: "" } }, content: "none" },
  database: { type: "database", propSchema: { databaseId: { default: "" } }, content: "none" },
  equation: { type: "equation", propSchema: {}, content: "plain" },
  diagram: { type: "diagram", propSchema: { language: { default: "mermaid", values: [...DIAGRAM_LANGUAGES] } }, content: "plain" },
  toc: { type: "toc", propSchema: { ...colors }, content: "none" },
  breadcrumb: { type: "breadcrumb", propSchema: {}, content: "none" },
  bookmark: {
    type: "bookmark",
    propSchema: { link: { default: "" }, title: { default: "" }, description: { default: "" }, image: { default: "" }, icon: { default: "" } },
    content: "none",
  },
  embed: { type: "embed", propSchema: { link: { default: "" }, height: { default: 400 } }, content: "none" },
  columnList: { type: "columnList", propSchema: {}, content: "none", layoutOnly: true, children: { allow: ["column"], min: 2 } },
  column: {
    type: "column",
    propSchema: { width: { default: 1 } },
    content: "none",
    layoutOnly: true,
    placeable: "namedOnly",
    children: { allow: "blocks", exclude: ["columnList"] },
  },
} as const;

/** Inline content: config for createInlineContentSpec / createReactInlineContentSpec. */
export const INLINES = {
  mention: { type: "mention", propSchema: { pageId: { default: "" } }, content: "none" },
  dateMention: { type: "dateMention", propSchema: { date: { default: "" }, end: { default: "" } }, content: "none" },
  personMention: { type: "personMention", propSchema: { userId: { default: "" } }, content: "none" },
  inlineEquation: { type: "inlineEquation", propSchema: {}, content: "plain" },
} as const;

/** Blocks whose source is shown as a preview (formula, diagram) and edited in a popup. */
export const PREVIEW_BLOCKS = ["equation", "diagram"];

/** Headings go to level 4 (as in Notion) and can be toggles. */
export const HEADING_OPTIONS = { levels: [1, 2, 3, 4], allowToggleHeadings: true } as const;

/** Languages code blocks offer (and highlight). The ids are Shiki's. */
export const CODE_LANGUAGES: Record<string, { name: string; aliases?: string[] }> = {
  text: { name: "Plain text", aliases: ["txt", "plaintext", "none"] },
  bash: { name: "Bash", aliases: ["sh", "shell", "zsh"] },
  c: { name: "C" },
  cpp: { name: "C++", aliases: ["c++"] },
  csharp: { name: "C#", aliases: ["cs", "c#"] },
  css: { name: "CSS" },
  dart: { name: "Dart" },
  diff: { name: "Diff" },
  docker: { name: "Dockerfile", aliases: ["dockerfile"] },
  elixir: { name: "Elixir" },
  go: { name: "Go", aliases: ["golang"] },
  graphql: { name: "GraphQL" },
  haskell: { name: "Haskell" },
  html: { name: "HTML" },
  java: { name: "Java" },
  javascript: { name: "JavaScript", aliases: ["js"] },
  json: { name: "JSON" },
  jsx: { name: "JSX" },
  kotlin: { name: "Kotlin", aliases: ["kt"] },
  latex: { name: "LaTeX", aliases: ["tex"] },
  lua: { name: "Lua" },
  makefile: { name: "Makefile", aliases: ["make"] },
  markdown: { name: "Markdown", aliases: ["md"] },
  matlab: { name: "MATLAB" },
  mermaid: { name: "Mermaid" },
  nginx: { name: "Nginx" },
  "objective-c": { name: "Objective-C", aliases: ["objc"] },
  perl: { name: "Perl" },
  php: { name: "PHP" },
  powershell: { name: "PowerShell", aliases: ["ps1", "pwsh"] },
  python: { name: "Python", aliases: ["py"] },
  r: { name: "R" },
  ruby: { name: "Ruby", aliases: ["rb"] },
  rust: { name: "Rust", aliases: ["rs"] },
  scala: { name: "Scala" },
  scss: { name: "SCSS" },
  sql: { name: "SQL" },
  swift: { name: "Swift" },
  toml: { name: "TOML" },
  tsx: { name: "TSX" },
  typescript: { name: "TypeScript", aliases: ["ts"] },
  vue: { name: "Vue" },
  xml: { name: "XML" },
  yaml: { name: "YAML", aliases: ["yml"] },
  plantuml: { name: "PlantUML", aliases: ["puml"] },
  dot: { name: "Graphviz (DOT)", aliases: ["graphviz", "gv"] },
};

/** Code blocks in these languages draw their diagram (Code / Preview / Split), as in Notion. */
export const DIAGRAM_CODE: Record<string, "mermaid" | "plantuml" | "graphviz"> = { mermaid: "mermaid", plantuml: "plantuml", puml: "plantuml", dot: "graphviz", graphviz: "graphviz", gv: "graphviz" };
/** Languages the code highlighter (Shiki) has no grammar for. */
export const NOT_HIGHLIGHTED = new Set(["text", "plantuml", "puml", "dot", "graphviz", "gv"]);

/** A code block language as the language picker lists it: its own id, the id it is an alias of, or plain text. */
export function codeLanguageId(lang: string): string {
  const l = String(lang ?? "").trim().toLowerCase();
  if (CODE_LANGUAGES[l]) return l;
  return Object.entries(CODE_LANGUAGES).find(([, v]) => v.aliases?.includes(l))?.[0] ?? "text";
}
