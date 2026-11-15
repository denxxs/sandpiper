// The block types and props an AI may use, as plain text for the server's instructions. Written out rather than read
// from the editor's schema so connecting doesn't have to start the editor; the engine tests check it still matches.
export const BLOCK_GUIDE =
  "paragraph; heading (level 1-4, isToggleable: a toggle heading whose children fold away); bulletListItem; numberedListItem (start: the number the list counts from); checkListItem (checked); toggleListItem; " +
  "quote; callout (emoji); codeBlock (language; its content is plain code); divider (no content); " +
  'table (content {"rows": [["a","b"],["c","d"]], "headerRows": 0|1, "headerCols": 0|1}; cells may be {"type":"tableCell","props":{backgroundColor, textColor, textAlignment, colspan, rowspan},"content":"…"}); ' +
  "image, video, audio (no content; url, caption, name, showPreview, previewWidth in pixels); file (url, name, caption); " +
  "pageLink (pageId: a link to a page); database (databaseId: a database shown inline; another page's database makes a linked view); " +
  "equation (content: TeX, shown as a formula); diagram (language: mermaid, plantuml or graphviz; content: the diagram's source); " +
  'columnList (side-by-side columns: its children are two or more {"type":"column","props":{"width":1},"children":[blocks]}; column width is relative, 1 by default); ' +
  "toc (a table of contents of the page's headings); breadcrumb (the page's path); bookmark (link: a web address shown with its title, description and image; title, description, image, icon fill in by themselves); " +
  "embed (link: a web page, video, map, Figma file… shown in place; height in pixels). " +
  'Inline items besides text, links and page mentions: {"type":"inlineEquation","content":"TeX"}, {"type":"dateMention","props":{"date":"YYYY-MM-DD","end":""}}, {"type":"personMention","props":{"userId":"…"}} (ids from list_people). ' +
  "Text blocks, callouts, images, files and tables also take textColor and backgroundColor (colours), and most take textAlignment (left, center, right, justify).";
