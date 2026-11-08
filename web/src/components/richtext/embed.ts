/**
 * The embed block in the editor (REC-6): a fenced code block with the info string `openbase` that holds one
 * embed (lib/embeds.ts), as an atom that draws as the embed (EmbedView) and is stored as exactly the text it was
 * read from. Markdown.tsx reads the same block for viewers.
 *
 * - Reading: a `code` token whose info string is exactly `openbase` and whose body is a valid embed becomes this
 *   node. Any other block, including an `openbase` one that does not read (malformed JSON, an unknown key, an
 *   id that is not an id), stays the code block it is, with its text unchanged, and is labelled "This embed can't
 *   be shown" by a decoration (the label is not part of the text).
 * - Writing: the node writes back the text it read, not a rewrite of it, so an agent's own spacing survives.
 * - A code block typed by hand as ```openbase and a valid body becomes the embed when the editor loses its focus,
 *   not while it is typed, when it would change under the person's fingers.
 * - The block menu's Linked records and View insert this node (blocks.ts).
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { UNREADABLE_TEXT } from "@/components/embeds/boxes";
import { embedOfBlock, isEmbedInfo, parseEmbed, EMBED_INFO } from "@/lib/embeds";
import { EmbedView } from "./EmbedView";

const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=combobox], [role=listbox], [role=dialog]";

const unreadableKey = new PluginKey<DecorationSet>("unreadableEmbeds");

export const EmbedNode = Node.create({
  name: "embed",
  // Ahead of the code block, so the Markdown reader offers it a `code` token first.
  priority: 101,
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return { source: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-ob-embed-source]",
        // Pasted from another page: read again, never trusted for having been an embed there.
        getAttrs: (el) => {
          const source = (el as HTMLElement).getAttribute("data-ob-embed-source") ?? "";
          return parseEmbed(source) ? { source } : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-ob-embed-source": node.attrs.source, class: "ob-embed ob-embed-static" }), "Embedded view"];
  },

  addNodeView() {
    // What is inside the block (a link, a button, the picker) answers its own clicks and keys; the editor does not.
    return ReactNodeViewRenderer(EmbedView, { className: "ob-embed-host", stopEvent: ({ event }) => event.target instanceof Element && !!event.target.closest(INTERACTIVE) });
  },

  markdownTokenName: "code",

  parseMarkdown: (token, helpers) => {
    const raw = typeof token.raw === "string" ? token.raw : "";
    // A fenced block only: an indented block of code is code, whatever it says.
    if (!raw.trimStart().startsWith("```") && !raw.trimStart().startsWith("~~~")) return [];
    const body = typeof token.text === "string" ? token.text : "";
    if (!embedOfBlock(typeof token.lang === "string" ? token.lang : "", body)) return [];
    return helpers.createNode("embed", { source: body.trim() });
  },

  renderMarkdown: (node) => `\`\`\`${EMBED_INFO}\n${String(node.attrs?.source ?? "")}\n\`\`\``,

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: unreadableKey,
        state: {
          init: (_config, state) => unreadable(state.doc),
          apply: (tr, set) => (tr.docChanged ? unreadable(tr.doc) : set),
        },
        props: { decorations: (state) => unreadableKey.getState(state) },
      }),
    ];
  },

  onBlur() {
    const { editor } = this;
    if (!editor.isEditable) return;
    const found: { pos: number; size: number; source: string }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "codeBlock" && embedOfBlock(node.attrs.language as string | null, node.textContent)) found.push({ pos, size: node.nodeSize, source: node.textContent.trim() });
      return node.type.name !== "codeBlock";
    });
    if (found.length === 0) return;
    const tr = editor.state.tr;
    // From the end, so the positions still to be replaced do not move.
    for (const { pos, size, source } of found.reverse()) tr.replaceWith(pos, pos + size, this.type.create({ source }));
    editor.view.dispatch(tr);
  },
});

/** The `openbase` code blocks that do not read as embeds, marked so the editor says why they show as code. */
function unreadable(doc: import("@tiptap/pm/model").Node): DecorationSet {
  const marks: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const info = node.attrs.language as string | null;
    if (isEmbedInfo(info) && !embedOfBlock(info, node.textContent)) marks.push(Decoration.node(pos, pos + node.nodeSize, { class: "ob-embed-code", "data-note": UNREADABLE_TEXT }));
    return false;
  });
  return marks.length > 0 ? DecorationSet.create(doc, marks) : DecorationSet.empty;
}
