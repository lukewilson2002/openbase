/**
 * The people picker of the rich text editors (the toolbar editor and the page): follows the `@` query at the
 * caret (mention.ts), filters `people` by it, takes the arrow keys, Enter and Tab while it shows (and Escape,
 * through `dismiss`), and places itself under the `@` (above it near the bottom of the window). The editor keeps
 * the focus and announces the list with the combobox attributes.
 */
import { useEffect, useId, useMemo, useState, type RefObject } from "react";
import type { useEditor } from "@tiptap/react";
import { matchPeople } from "@/components/record/mentions";
import { anchorStyle } from "./anchor";
import { dismissMention, mentionQuery, type MentionQuery } from "./mention";
import type { MentionPerson } from "./MentionPicker";

/** Whether a text box, or anything else that takes typing, has the focus already. */
export function typingElsewhere(): boolean {
  const el = document.activeElement;
  return !!el && el !== document.body && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
}

type TiptapEditor = NonNullable<ReturnType<typeof useEditor>>;

export function useMentionPicker(editor: TiptapEditor | null, people: readonly MentionPerson[] | undefined, box: RefObject<HTMLDivElement | null>) {
  const listId = useId();
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!editor || !people) return;
    const follow = () => {
      const next = editor.isInitialized && editor.isFocused ? mentionQuery(editor.state) : null;
      setQuery((q) => (q?.from === next?.from && q?.to === next?.to && q?.query === next?.query ? q : next));
    };
    follow();
    editor.on("transaction", follow);
    editor.on("focus", follow);
    editor.on("blur", follow);
    return () => {
      editor.off("transaction", follow);
      editor.off("focus", follow);
      editor.off("blur", follow);
    };
  }, [editor, people]);

  const matches = useMemo(() => (query && people ? matchPeople(people, query.query) : []), [query, people]);
  const open = matches.length > 0;
  // A new query starts at the top of its list.
  useEffect(() => setActive(0), [query?.from, query?.query]);

  const choose = (p: MentionPerson) => {
    if (!editor || !query) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: query.from, to: query.to }, [
        { type: "mention", attrs: { id: p.id, label: p.name } },
        { type: "text", text: " " },
      ])
      .run();
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (!editor || !open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + matches.length) % matches.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const p = matches[Math.min(active, matches.length - 1)];
      if (p) choose(p);
      return true;
    }
    return false;
  };

  const dismiss = () => {
    if (editor) editor.view.dispatch(dismissMention(editor.state));
  };

  // The editor is the combobox: it keeps the focus while the list shows. Meanwhile Escape is the list's:
  // `data-escape-cancels` tells what has its own use for Escape around the editor (the record page, the full-screen dialog) to leave it alone.
  useEffect(() => {
    if (!editor?.isInitialized || editor.isDestroyed || !people) return;
    const dom = editor.view.dom;
    dom.setAttribute("aria-autocomplete", "list");
    dom.setAttribute("aria-expanded", String(open));
    if (open) {
      dom.setAttribute("aria-controls", listId);
      dom.setAttribute("aria-activedescendant", `${listId}-${active}`);
      dom.setAttribute("data-escape-cancels", "");
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
      dom.removeAttribute("data-escape-cancels");
    }
  }, [editor, people, open, active, listId]);

  const style = open && editor?.isInitialized && query && box.current ? anchorStyle(editor, box.current, query.from, 260) : undefined;

  return { open, matches, active, choose, onKey, dismiss, listId, style };
}
