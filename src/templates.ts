// Starter content, expressed as editor blocks.
const h = (level: number, text: string) => ({ type: "heading", props: { level }, content: text });
const p = (content: any = "") => ({ type: "paragraph", content });
const b = (text: string) => ({ type: "bulletListItem", content: text });
const todo = (text: string, checked = false) => ({ type: "checkListItem", props: { checked }, content: text });
const bold = (text: string) => ({ type: "text", text, styles: { bold: true } });
const code = (text: string) => ({ type: "text", text, styles: { code: true } });
const t = (text: string) => ({ type: "text", text, styles: {} });

export const TEMPLATES: Record<string, { label: string; icon: string; blocks: any[] }> = {
  welcome: {
    label: "Welcome",
    icon: "👋",
    blocks: [
      p([t("Welcome to Sandpiper — a workspace for notes, docs and databases that everyone can edit together, live.")]),
      { type: "callout", props: { emoji: "💡" }, content: [bold("Try it: "), t("open this page in a second browser tab. You'll see each other's cursors and edits as they happen.")] },
      h(2, "The basics"),
      todo("Click anywhere and just start typing", true),
      todo("Type / to open the block menu — headings, lists, tables, images, code and more"),
      todo("Select text to format it, turn it into a link, or leave a comment"),
      todo("Drag the ⋮⋮ handle beside any block to move it"),
      todo("Type @ to mention another page"),
      todo("Hover a page in the sidebar and press + to nest a page inside it"),
      h(2, "Shortcuts"),
      b("Ctrl/Cmd + K — search everything"),
      b("Ctrl/Cmd + \\ — show or hide the sidebar"),
      b("Ctrl/Cmd + B / I / U — bold, italic, underline"),
      { type: "bulletListItem", content: [t("Type "), code("#"), t(", "), code("-"), t(", "), code("1."), t(", "), code("[]"), t(" or "), code(">"), t(" then space for quick blocks")] },
      h(2, "Databases"),
      p([t("Open "), bold("Tasks"), t(" in the sidebar to see a database. Switch between table, board and calendar views, add properties, filter and sort. Every row is its own page.")]),
      { type: "toggleListItem", content: "What's stored where?", children: [p("Everything is saved on the server in the data folder next to the app, and synced to every connected browser in real time.")] },
      p(),
    ],
  },
  meeting: {
    label: "Meeting notes",
    icon: "📝",
    blocks: [
      h(2, "Attendees"),
      b(""),
      h(2, "Agenda"),
      { type: "numberedListItem", content: "" },
      h(2, "Notes"),
      p(),
      h(2, "Action items"),
      todo(""),
    ],
  },
  todo: {
    label: "To-do list",
    icon: "☑️",
    blocks: [h(2, "Today"), todo(""), todo(""), h(2, "Later"), todo("")],
  },
  doc: {
    label: "Project doc",
    icon: "📄",
    blocks: [
      { type: "callout", props: { emoji: "🎯" }, content: [bold("Goal: "), t("one sentence on what this project achieves.")] },
      h(2, "Background"),
      p(),
      h(2, "Proposal"),
      p(),
      h(2, "Open questions"),
      b(""),
      h(2, "Timeline"),
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: ["Milestone", "Owner", "Date"] }, { cells: ["", "", ""] }, { cells: ["", "", ""] }],
        },
      },
    ],
  },
  journal: {
    label: "Journal",
    icon: "📔",
    blocks: [h(2, new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })), p(), { type: "quote", content: "" }],
  },
};
