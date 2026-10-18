/**
 * The media block: an uploaded image, video, audio file or other file shown as a block of its own
 * in the editor, stored as Markdown image syntax on a line of its own so a value stays readable
 * everywhere (and for agents):
 *
 *     ![Alt text](/api/attachments/att_1/photo.png "Caption")
 *
 * Only addresses of our own files are media (`lib/media.ts`). Any other image in Markdown (an
 * outside address, a data: URL) is read as an ordinary link and never fetched. Images that sit in
 * the middle of a paragraph are lifted out into blocks of their own.
 *
 * With an `upload` function the node also takes files: the `uploadMedia` command (the toolbar's
 * button) and files pasted or dropped on the editor. Each file gets an "Uploading…" placeholder
 * where it will land (a decoration, so the document and its Markdown never hold half a block); on
 * success it is replaced by the block, on failure it is removed and `onError` says why.
 */
import { Extension, Node, mergeAttributes, type JSONContent, type MarkdownParseHelpers, type MarkdownToken } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { AttachmentRef } from "@/api/types";
import { embedSrc, isEmbedSrc } from "@/lib/media";
import { MediaView } from "./MediaView";

export interface MediaOptions {
  /** Uploads a file and answers its reference. Without it files cannot be added. */
  upload?: () => ((file: File) => Promise<AttachmentRef>) | undefined;
  /** An upload failed (the placeholder is gone). */
  onError?: (file: File, error: unknown) => void;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    media: {
      /** Upload files and insert a media block for each at the cursor (or at `pos`, a position in the document). */
      uploadMedia: (files: readonly File[], pos?: number) => ReturnType;
    };
  }
}

/** marked escapes `& < > " '` in image alt text and titles. */
function unescapeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? m);
}

/** A media block for a Markdown image token. */
function mediaNode(token: MarkdownToken): JSONContent {
  return {
    type: "media",
    attrs: { src: String(token.href), alt: unescapeEntities(String(token.text ?? "")), title: token.title ? unescapeEntities(String(token.title)) : "" },
  };
}

const isEmbedToken = (t: MarkdownToken): boolean => t.type === "image" && isEmbedSrc(t.href);

/** Whitespace and line breaks that only separated an image from the text around it. */
function trimRun(run: MarkdownToken[]): MarkdownToken[] {
  const out = [...run];
  const blank = (t: MarkdownToken | undefined) => !!t && (t.type === "br" || (t.type === "text" && !String(t.text ?? "").trim() && !t.tokens?.length));
  while (blank(out[0])) out.shift();
  while (blank(out[out.length - 1])) out.pop();
  const first = out[0];
  if (first?.type === "text" && !first.tokens?.length) out[0] = { ...first, text: String(first.text ?? "").trimStart() };
  const last = out[out.length - 1];
  if (last?.type === "text" && !last.tokens?.length) out[out.length - 1] = { ...last, text: String(last.text ?? "").trimEnd() };
  return out;
}

/**
 * A paragraph, with the images of our own files in it lifted out into media blocks (the text before,
 * between and after them stays paragraphs). Any other image is inline and read as a link by `ImageAsLink`.
 */
export function parseParagraph(token: MarkdownToken, helpers: MarkdownParseHelpers): JSONContent | JSONContent[] {
  const tokens = (token.tokens ?? []) as MarkdownToken[];
  if (!tokens.some(isEmbedToken)) return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
  const out: JSONContent[] = [];
  let run: MarkdownToken[] = [];
  const flush = () => {
    const text = trimRun(run);
    if (text.length > 0) out.push(helpers.createNode("paragraph", undefined, helpers.parseInline(text)));
    run = [];
  };
  for (const t of tokens) {
    if (isEmbedToken(t)) {
      flush();
      out.push(mediaNode(t));
    } else run.push(t);
  }
  flush();
  return out;
}

/** An image that is not one of our files is a link: its alt text (or its address) is the text. Never an `<img>`. */
export const ImageAsLink = Extension.create({
  name: "imageAsLink",
  markdownTokenName: "image",
  parseMarkdown: (token) => {
    const href = String(token.href ?? "");
    const alt = unescapeEntities(String(token.text ?? "")).trim();
    const text = alt || (href.startsWith("data:") ? "image" : href);
    return { type: "text", text, marks: [{ type: "link", attrs: { href, title: token.title ? unescapeEntities(String(token.title)) : null } }] };
  },
});

// ---------------------------------------------------------------------------------------------
// Uploads

const uploadKey = new PluginKey<DecorationSet>("mediaUploads");

interface PendingSpec {
  id: number;
  /** An empty paragraph right before the placeholder (the one the cursor was in) goes when the block lands. */
  replaceEmpty: boolean;
}

let nextId = 1;

function placeholder(name: string): () => HTMLElement {
  return () => {
    const el = document.createElement("div");
    el.className = "ob-media-pending";
    el.contentEditable = "false";
    el.setAttribute("role", "status");
    const spin = document.createElement("span");
    spin.className = "ob-spin ob-media-pending-icon";
    spin.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = `Uploading ${name}…`;
    el.append(spin, label);
    return el;
  };
}

/** Where a block goes for the cursor (or a position): after the textblock it is in, or in place if between blocks. */
function blockPos(state: EditorState, at?: number): number {
  if (at === undefined && state.selection instanceof NodeSelection) return state.selection.to;
  const $pos = state.doc.resolve(at ?? state.selection.to);
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).isTextblock) return $pos.after(d);
  return $pos.pos;
}

function startUploads(view: EditorView, files: readonly File[], at: number | undefined, options: MediaOptions): boolean {
  const upload = options.upload?.();
  if (!upload || files.length === 0) return false;
  const { state } = view;
  const pos = blockPos(state, at);
  const before = state.doc.resolve(pos).nodeBefore;
  const emptyHere = !!before && before.type.name === "paragraph" && before.content.size === 0 && at === undefined && state.selection.empty && state.selection.from === pos - 1;
  const jobs = files.map((file, i) => ({ file, spec: { id: nextId++, replaceEmpty: emptyHere && i === 0 } satisfies PendingSpec }));
  view.dispatch(
    state.tr.setMeta(uploadKey, {
      add: jobs.map((j) => Decoration.widget(pos, placeholder(j.file.name), { id: j.spec.id, replaceEmpty: j.spec.replaceEmpty, side: 1, key: `upload-${j.spec.id}` })),
    }),
  );
  void (async () => {
    // One after the other, in the order the files were given (as the attachment cells do).
    for (const { file, spec } of jobs) {
      try {
        const ref = await upload(file);
        if (view.isDestroyed) return;
        land(view, spec, { src: embedSrc(ref.id, ref.filename), alt: "", title: "" });
      } catch (e) {
        if (view.isDestroyed) return;
        const { state } = view;
        const tr = state.tr.setMeta(uploadKey, { remove: spec.id });
        // The file before it may have waited for this one to leave room below it.
        const othersWait = (uploadKey.getState(state)?.find(undefined, undefined, (s) => (s as PendingSpec).id !== spec.id).length ?? 0) > 0;
        if (!othersWait && state.doc.lastChild?.type.name === "media") tr.insert(state.doc.content.size, state.schema.nodes.paragraph!.create());
        view.dispatch(tr);
        options.onError?.(file, e);
      }
    }
  })();
  return true;
}

/** Replace a placeholder by the block it stood for. */
function land(view: EditorView, spec: PendingSpec, attrs: { src: string; alt: string; title: string }): void {
  const { state } = view;
  const found = uploadKey.getState(state)?.find(undefined, undefined, (s) => (s as PendingSpec).id === spec.id)[0];
  const tr = state.tr.setMeta(uploadKey, { remove: spec.id });
  const node = state.schema.nodes.media!.create(attrs);
  // The placeholder was lost with the text around it: the block goes at the end rather than nowhere.
  let pos = found ? found.from : state.doc.content.size;
  const prev = tr.doc.resolve(pos).nodeBefore;
  if (spec.replaceEmpty && prev && prev.type.name === "paragraph" && prev.content.size === 0) {
    tr.delete(pos - prev.nodeSize, pos);
    pos -= prev.nodeSize;
  }
  tr.insert(pos, node);
  // Something to type in after a block that ends the document (the last of several files leaves it, so it stays below them all).
  const othersWait = (uploadKey.getState(state)?.find(undefined, undefined, (s) => (s as PendingSpec).id !== spec.id).length ?? 0) > 0;
  if (!othersWait && pos + node.nodeSize >= tr.doc.content.size) tr.insert(pos + node.nodeSize, state.schema.nodes.paragraph!.create());
  view.dispatch(tr.scrollIntoView());
}

function filesOf(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

export const Media = Node.create<MediaOptions>({
  name: "media",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {};
  },

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "" },
      title: { default: "" },
    };
  },

  parseHTML() {
    return [
      { tag: "figure[data-ob-media]", getAttrs: (el) => attrsFromData(el as HTMLElement) },
      // Copied out of the read-only rendering (Markdown.tsx).
      { tag: "figure.ob-media", getAttrs: (el) => attrsFromRendered(el as HTMLElement) },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-ob-media": "", "data-src": node.attrs.src, "data-alt": node.attrs.alt, "data-title": node.attrs.title })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MediaView, { className: "ob-media-host" });
  },

  renderMarkdown: (node) => {
    const src = String(node.attrs?.src ?? "");
    if (!isEmbedSrc(src)) return "";
    const alt = String(node.attrs?.alt ?? "").replace(/\s*\n\s*/g, " ").replace(/[[\]]/g, "\\$&");
    const title = String(node.attrs?.title ?? "").replace(/\s*\n\s*/g, " ").replace(/[\\"]/g, "\\$&");
    return `![${alt}](${src}${title ? ` "${title}"` : ""})`;
  },

  addCommands() {
    return {
      uploadMedia:
        (files, pos) =>
        ({ view }) =>
          startUploads(view, files, pos, this.options),
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<DecorationSet>({
        key: uploadKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const next = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(uploadKey) as { add?: Decoration[]; remove?: number } | undefined;
            if (!meta) return next;
            let out = next;
            if (meta.add) out = out.add(tr.doc, meta.add);
            if (meta.remove !== undefined) out = out.remove(out.find(undefined, undefined, (s) => (s as PendingSpec).id === meta.remove));
            return out;
          },
        },
        props: {
          decorations: (state) => uploadKey.getState(state),
          handlePaste(view, event) {
            if (!options.upload?.()) return false;
            const files = filesOf(event.clipboardData?.files);
            // A table copied from a spreadsheet carries a picture of itself next to its text: that is a paste of text.
            if (files.length === 0 || event.clipboardData?.getData("text/plain")) return false;
            event.preventDefault();
            return startUploads(view, files, undefined, options);
          },
          handleDrop(view, event, _slice, moved) {
            if (moved || !options.upload?.()) return false;
            const files = filesOf(event.dataTransfer?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            return startUploads(view, files, at?.pos ?? view.state.doc.content.size, options);
          },
        },
      }),
    ];
  },
});

function attrsFromData(el: HTMLElement): Record<string, string> | false {
  const src = el.getAttribute("data-src");
  if (!isEmbedSrc(src)) return false;
  return { src: src!, alt: el.getAttribute("data-alt") ?? "", title: el.getAttribute("data-title") ?? "" };
}

function attrsFromRendered(el: HTMLElement): Record<string, string> | false {
  const medium = el.querySelector<HTMLElement>("img, video, audio, a[download]");
  const src = medium?.getAttribute("src") ?? medium?.getAttribute("data-embed") ?? medium?.getAttribute("href");
  // Drop a share token that was appended for a public page.
  const bare = src?.split("?")[0];
  if (!isEmbedSrc(bare)) return false;
  return { src: bare!, alt: medium?.getAttribute("alt") ?? "", title: el.querySelector("figcaption")?.textContent ?? "" };
}
