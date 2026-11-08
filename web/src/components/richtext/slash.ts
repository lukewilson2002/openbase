/**
 * The page's two keyboard hooks into the editor.
 *
 * `SlashSuggest` watches the text before the caret: a `/` at the start of a block or after a space, followed by
 * what is being typed, is a query ([`slashQuery`]) that the page turns into the block menu (PageEditor). While the
 * menu shows, its keys (arrows, Enter, Tab, Escape) go to `onKeyDown` first. It follows mention.ts, which does the
 * same for `@`.
 *
 * `LinkShortcut` makes Ctrl+K (Cmd+K on a Mac) add a link while the page has focus. Handling the key makes
 * ProseMirror call `preventDefault()`, which is how the command palette knows to yield (NAV-9).
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";

/** A `/query` being typed: the document range it covers (the `/` included) and the text after the slash. */
export interface SlashQuery {
  from: number;
  to: number;
  query: string;
}

/** The longest query still read as a command: past it the slash was ordinary text ("1/2 of a pie, and/or this"). */
const MAX_QUERY = 24;
/** One character stands for each inline leaf (a mention, a line break) in the text before the caret. */
const LEAF = "￼";

/** The query at the end of `text` (the block's text before the caret), if there is one. */
export function openSlash(text: string): { start: number; query: string } | null {
  const start = text.lastIndexOf("/");
  if (start < 0) return null;
  // Only after a space or at the start of the block: not in "https://", "and/or" or a path.
  if (start > 0 && !/\s/.test(text[start - 1]!)) return null;
  const query = text.slice(start + 1);
  if (query.length > MAX_QUERY || query.includes(LEAF)) return null;
  return { start, query };
}

interface SuggestState {
  query: SlashQuery | null;
  /** Where the query that Escape closed starts; it stays closed until the caret leaves it. */
  dismissedAt: number | null;
}

export const slashSuggestKey = new PluginKey<SuggestState>("slashSuggest");

function findQuery(state: EditorState): SlashQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  if ($from.marks().some((m) => m.type.name === "code")) return null;
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, LEAF);
  const open = openSlash(text);
  if (!open) return null;
  return { from: $from.start() + open.start, to: $from.pos, query: open.query };
}

/** The open (not dismissed) query of an editor state, if any. */
export function slashQuery(state: EditorState): SlashQuery | null {
  const s = slashSuggestKey.getState(state);
  return s?.query && s.query.from !== s.dismissedAt ? s.query : null;
}

/** Close the open query (Escape): typing on after the same slash keeps it closed. */
export function dismissSlash(state: EditorState) {
  return state.tr.setMeta(slashSuggestKey, "dismiss");
}

export interface SlashSuggestOptions {
  /** A key pressed while the menu shows; true when it was handled (and so not for the editor). */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const SlashSuggest = Extension.create<SlashSuggestOptions>({
  name: "slashSuggest",

  addOptions() {
    return { onKeyDown: () => false };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<SuggestState>({
        key: slashSuggestKey,
        state: {
          init: (_config, state) => ({ query: findQuery(state), dismissedAt: null }),
          apply: (tr, prev, _old, state) => {
            const query = findQuery(state);
            if (tr.getMeta(slashSuggestKey) === "dismiss") return { query, dismissedAt: query?.from ?? null };
            return { query, dismissedAt: query && prev.dismissedAt === query.from ? prev.dismissedAt : null };
          },
        },
        // The page decides whether the menu is showing (it also shows from the phone's "+" and for the second
        // step of an embed, with no slash typed), so every key is offered to it.
        props: { handleKeyDown: (_view, event) => options.onKeyDown(event) },
      }),
    ];
  },
});

export interface LinkShortcutOptions {
  onLink: () => void;
}

export const LinkShortcut = Extension.create<LinkShortcutOptions>({
  name: "linkShortcut",

  addOptions() {
    return { onLink: () => {} };
  },

  addKeyboardShortcuts() {
    const run = () => {
      this.options.onLink();
      return true;
    };
    // Both work on every keyboard, as they do for the palette (people switch machines).
    return { "Ctrl-k": run, "Meta-k": run };
  },
});
