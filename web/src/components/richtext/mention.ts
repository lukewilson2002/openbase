/**
 * @mentions in the rich text editor.
 *
 * `Mention` is an inline atom shown as a chip (`.ob-mention`) and stored as `@[Name](usrXXXX)`, the
 * Markdown form comments and rich text share (record/mentions.ts; the server finds mentions in it to
 * notify people). Every editor reads and writes the node, so a value with mentions survives any edit.
 *
 * `MentionSuggest` watches the text before the caret: an `@` at a word start followed by a name being
 * typed is a query ([`mentionQuery`]), which the editor turns into a list of people to pick from
 * (RichTextEditor). While a query is open its keys (arrows, Enter, Tab) go to `onKeyDown` first;
 * Escape closes it with `dismissMention`.
 */
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { MENTION_AT_START, mentionMarkup, openMention } from "@/components/record/mentions";

export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      id: {
        default: null as string | null,
        parseHTML: (el) => el.getAttribute("data-mention"),
        renderHTML: (attrs) => ({ "data-mention": attrs.id as string }),
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? (el.textContent ?? "").replace(/^@/, ""),
        renderHTML: (attrs) => ({ "data-label": attrs.label as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "ob-mention" }), `@${node.attrs.label as string}`];
  },

  renderText({ node }) {
    return `@${node.attrs.label as string}`;
  },

  markdownTokenizer: {
    name: "mention",
    level: "inline",
    start: (src: string) => src.indexOf("@["),
    tokenize: (src: string) => {
      const m = MENTION_AT_START.exec(src);
      return m ? { type: "mention", raw: m[0], label: m[1]!, id: m[2]! } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "mention", attrs: { id: token.id as string, label: token.label as string } }),
  renderMarkdown: (node) => mentionMarkup({ userId: String(node.attrs?.id ?? ""), name: String(node.attrs?.label ?? "") }),
});

/** An `@name` being typed: the document range it covers (the `@` included) and the name so far. */
export interface MentionQuery {
  from: number;
  to: number;
  query: string;
}

interface SuggestState {
  query: MentionQuery | null;
  /** Where the query that Escape closed starts; it stays closed until the caret leaves it. */
  dismissedAt: number | null;
}

export const mentionSuggestKey = new PluginKey<SuggestState>("mentionSuggest");

/** The query at the caret of `state`, whether or not it was dismissed. */
function findQuery(state: EditorState): MentionQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  if ($from.marks().some((m) => m.type.name === "code")) return null;
  // One character per position: every inline leaf (a mention, a line break) reads as one.
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const open = openMention(text, text.length);
  if (!open) return null;
  return { from: $from.start() + open.start, to: $from.pos, query: open.query };
}

/** The open (not dismissed) query of an editor state, if any. */
export function mentionQuery(state: EditorState): MentionQuery | null {
  const s = mentionSuggestKey.getState(state);
  return s?.query && s.query.from !== s.dismissedAt ? s.query : null;
}

/** Close the open query (Escape): typing on in the same word keeps it closed. */
export function dismissMention(state: EditorState) {
  return state.tr.setMeta(mentionSuggestKey, "dismiss");
}

export interface MentionSuggestOptions {
  /** A key pressed while a query is open; true when it was handled (and so not for the editor). */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const MentionSuggest = Extension.create<MentionSuggestOptions>({
  name: "mentionSuggest",

  addOptions() {
    return { onKeyDown: () => false };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<SuggestState>({
        key: mentionSuggestKey,
        state: {
          init: (_config, state) => ({ query: findQuery(state), dismissedAt: null }),
          apply: (tr, prev, _old, state) => {
            const query = findQuery(state);
            if (tr.getMeta(mentionSuggestKey) === "dismiss") return { query, dismissedAt: query?.from ?? null };
            return { query, dismissedAt: query && prev.dismissedAt === query.from ? prev.dismissedAt : null };
          },
        },
        props: {
          handleKeyDown: (view, event) => (mentionQuery(view.state) ? options.onKeyDown(event) : false),
        },
      }),
    ];
  },
});
