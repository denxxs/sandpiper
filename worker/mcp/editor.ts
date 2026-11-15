// A headless BlockNote editor with the same schema as the app's (src/components/Editor.tsx), used to turn blocks into
// the exact Yjs structure the app's editor reads and writes, and back. It never touches a browser or the live
// document's ProseMirror binding: reading serialises the Yjs XML as it is, and new content is built in a scratch
// document and copied in.
//
// Keep the custom blocks and inline content below in step with Editor.tsx: same type names, props and content kinds.
import * as Y from "yjs";
import {
  BlockNoteEditor,
  BlockNoteSchema,
  createBlockSpec,
  createCodeBlockSpec,
  createExtension,
  createHeadingBlockSpec,
  createInlineContentSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { BLOCKS, CODE_LANGUAGES, HEADING_OPTIONS, INLINES, PREVIEW_BLOCKS } from "../../shared/blocks";
import { CommentMark } from "@blocknote/core/comments";
import { _prosemirrorJSONToBlocks, blocksToYXmlFragment } from "@blocknote/core/yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as sha256 from "lib0/hash/sha256";
import * as buf from "lib0/buffer";
import { fail } from "./util";

const noRender = () => ({ dom: null as any });

let editor: any = null;

/** The headless editor, created the first time a document needs it. */
export function getEditor(): any {
  if (editor) return editor;
  // The same blocks as the app, from the same configuration (shared/blocks.ts); nothing is drawn here.
  const blocks: Record<string, any> = {};
  for (const [name, config] of Object.entries(BLOCKS)) {
    const impl: any = (config as any).layoutOnly ? { renderFrame: noRender } : { render: noRender };
    if (PREVIEW_BLOCKS.includes(name)) impl.meta = { hasPreview: true, code: true };
    blocks[name] = (createBlockSpec(config as any, impl) as any)();
  }
  const inlines: Record<string, any> = {};
  for (const [name, config] of Object.entries(INLINES)) {
    inlines[name] = createInlineContentSpec(config as any, { render: noRender, ...(name === "inlineEquation" ? { meta: { hasPreview: true, code: true } } : {}) } as any);
  }
  const schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      heading: createHeadingBlockSpec(HEADING_OPTIONS as any),
      codeBlock: createCodeBlockSpec({ supportedLanguages: CODE_LANGUAGES, defaultLanguage: "text" }),
      ...blocks,
    } as any,
    inlineContentSpecs: { ...defaultInlineContentSpecs, ...inlines } as any,
  });
  editor = BlockNoteEditor.create({
    schema,
    _headless: true,
    // Comments are marks on the text; the schema has to know them or text carrying one can't be read.
    extensions: [(createExtension as any)({ key: "commentMark", tiptapExtensions: [CommentMark] })],
  } as any);
  return editor;
}

/** Block types, with their props and what content they hold. */
export function blockSchema(): Record<string, { propSchema: Record<string, { default: any; values?: any[] }>; content: "inline" | "plain" | "table" | "none" }> {
  return getEditor().schema.blockSchema;
}

// ---------------------------------------------------------------- reading

/** Every block in a document fragment, as BlockNote blocks (with ids). Reads only; never changes the document. */
export function readBlocks(fragment: Y.XmlFragment | Y.XmlElement): any[] {
  if (fragment.length === 0) return [];
  const json = yXmlFragmentToProsemirrorJSON(fragment as Y.XmlFragment);
  try {
    return _prosemirrorJSONToBlocks(getEditor(), json);
  } catch (err) {
    console.error("couldn't read document", err);
    fail("This page's content couldn't be read.");
  }
}

/** One block container (from the live document) as a BlockNote block, children included. */
export function readContainer(container: Y.XmlElement): any {
  const json = { type: "doc", content: [{ type: "blockGroup", content: [serialize(container)] }] };
  return _prosemirrorJSONToBlocks(getEditor(), json)[0];
}

/** The same serialisation y-prosemirror uses, for a single element. */
function serialize(item: Y.XmlElement | Y.XmlText): any {
  if (item instanceof Y.XmlText) {
    return item.toDelta().map((d: any) => {
      const node: any = { type: "text", text: d.insert };
      if (d.attributes) node.marks = Object.keys(d.attributes).map((k) => ({ type: k.replace(/--[a-zA-Z0-9+/=]{8}$/, ""), attrs: d.attributes[k] }));
      return node;
    });
  }
  const node: any = { type: item.nodeName };
  const attrs = item.getAttributes();
  if (Object.keys(attrs).length) node.attrs = attrs;
  const children = item.toArray();
  if (children.length) node.content = children.flatMap((c) => serialize(c as any));
  return node;
}

// ---------------------------------------------------------------- writing

/**
 * Builds the Yjs elements (one block container each) for these blocks, ready to insert into a live document.
 * Blocks without an id get a new one; the result says which.
 */
export function buildContainers(blocks: any[]): Y.XmlElement[] {
  if (!blocks.length) return [];
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment("content");
    try {
      blocksToYXmlFragment(getEditor(), blocks, fragment);
    } catch (err: any) {
      fail(`Those blocks aren't valid: ${String(err?.message ?? err).slice(0, 300)}`);
    }
    const group = fragment.get(0) as Y.XmlElement;
    return group.toArray().map((c) => (c as Y.XmlElement).clone());
  } finally {
    scratch.destroy();
  }
}

/** Just the block element itself (paragraph, heading…, without its container or nested blocks), ready to insert. */
export function buildBlockElement(block: any): Y.XmlElement {
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment("content");
    try {
      blocksToYXmlFragment(getEditor(), [block], fragment);
    } catch (err: any) {
      fail(`That block isn't valid: ${String(err?.message ?? err).slice(0, 300)}`);
    }
    const container = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    return (container.get(0) as Y.XmlElement).clone();
  } finally {
    scratch.destroy();
  }
}

/** A brand-new (not yet inserted) block group holding these blocks. */
export function buildGroup(blocks: any[]): Y.XmlElement {
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, buildContainers(blocks));
  return group;
}

// ---------------------------------------------------------------- inline styles as Yjs text attributes

const hashOfJSON = (json: unknown) => {
  const digest = sha256.digest(buf.encodeAny(json));
  for (let i = 6; i < digest.length; i++) digest[i % 6] = digest[i % 6] ^ digest[i];
  return buf.toBase64(digest.slice(0, 6));
};

/**
 * The text attribute y-prosemirror stores for a mark: its name (or name plus a hash, for marks that can overlap,
 * like comments) and its full attributes, defaults included.
 */
export function markAttr(name: string, attrs?: Record<string, unknown>): [string, Record<string, unknown>] {
  const type = getEditor().pmSchema.marks[name];
  if (!type) fail(`Unknown text style "${name}".`);
  const mark = type.create(attrs ?? null);
  const key = type.excludes(type) ? name : `${name}--${hashOfJSON(mark.toJSON())}`;
  return [key, mark.attrs];
}

/** Every key a mark may be stored under in a text's attributes (overlapping marks carry a hash). */
export function isMarkKey(key: string, name: string) {
  return key === name || key.startsWith(name + "--");
}
