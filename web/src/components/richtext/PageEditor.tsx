/**
 * The editor of a record's Page (REC-5): the rich text editor of the rest of the app (Tiptap on top, plain
 * Markdown stored; see RichTextEditor and extensions.ts) dressed as a document. There is no box and no toolbar at
 * rest; formatting comes from what is typed instead:
 *
 * - Markdown shortcuts (`# `, `- `, `1. `, `> `, ```` ``` ````, `**bold**`) as in the toolbar editor.
 * - `/` opens the block menu (SlashMenu.tsx); on a phone its "+" does, since the keyboard is one thing short of a slash.
 * - Selecting text shows a bubble with bold, italic, strike, code and link (desktop). On a phone the same controls
 *   are a bar standing on the keyboard while the page has focus (PageOverlays.tsx).
 * - Ctrl+K (Cmd+K) adds a link while the page has focus. The command palette yields to it (NAV-9): the shortcut
 *   handler marks the key press as handled.
 *
 * `value` is the Markdown the page starts as. The host rebuilds the editor (a new `key`) when the record changes
 * under it, so there is no echo to filter out here. Text is 15/24 on a desktop and 16/25 on a phone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Selection } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { errorMessage } from "@/api/client";
import type { AttachmentRef } from "@/api/types";
import { useToastIfAny } from "@/components/ui/toast";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { richTextExtensions } from "./extensions";
import { MentionPicker, type MentionPerson } from "./MentionPicker";
import { FormatBar, SelectionBubble } from "./PageOverlays";
import { LinkShortcut, SlashSuggest } from "./slash";
import { SlashMenuList, useSlashMenu, type EmbedChoices } from "./SlashMenu";
import { typingElsewhere, useMentionPicker } from "./useMentionPicker";

export const PAGE_PLACEHOLDER = "Type / to add a heading, a list, a view or a property";

export interface PageEditorProps {
  /** Markdown. */
  value: string;
  /** Called with the Markdown after every edit. */
  onChange(md: string): void;
  /** Focus left the page. */
  onBlur?(): void;
  autoFocus?: boolean;
  /** Uploads a file to where it will be kept and answers its reference. Without it the menu has no Image or file. */
  upload?: (file: File) => Promise<AttachmentRef>;
  /** Who can be mentioned. */
  people?: readonly MentionPerson[];
  /** What Linked records and View can embed here. */
  embeds: EmbedChoices;
  /** Opens the box that adds a property to the record (the block menu's Property); absent for people who cannot. */
  onAddProperty?: () => void;
  "aria-label"?: string;
}

export function PageEditor({ value, onChange, onBlur, autoFocus, upload, people, embeds, onAddProperty, "aria-label": label = "Page" }: PageEditorProps) {
  const phone = !useMediaQuery(DESKTOP_QUERY);
  const toast = useToastIfAny();
  const [linkOpen, setLinkOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const files = useRef<HTMLInputElement>(null);
  // Callbacks change every render; the editor is created once and reads the latest through this.
  const cb = useRef({ onChange, onBlur, upload, toast, mentionKey: ((_e: KeyboardEvent) => false) as (e: KeyboardEvent) => boolean, slashKey: ((_e: KeyboardEvent) => false) as (e: KeyboardEvent) => boolean });
  cb.current = { ...cb.current, onChange, onBlur, upload, toast };
  const canMention = !!people;
  const extensions = useMemo(
    () => [
      ...richTextExtensions(
        PAGE_PLACEHOLDER,
        {
          upload: () => cb.current.upload,
          onError: (file, e) => cb.current.toast?.toast({ title: `${file.name} was not added`, description: errorMessage(e), variant: "error", durationMs: 8000 }),
        },
        canMention ? { onKeyDown: (e) => cb.current.mentionKey(e) } : undefined,
      ),
      // The selection stays drawn while the link address is typed outside the text.
      Selection,
      SlashSuggest.configure({ onKeyDown: (e) => cb.current.slashKey(e) }),
      LinkShortcut.configure({ onLink: () => setLinkOpen(true) }),
    ],
    [canMention],
  );
  const known = useRef(value);
  const focusOnCreate = useRef(autoFocus);

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        // Enter in the record's title lands here (RecordPage).
        "data-record-page": "",
        class: "ob-prose ob-editor min-h-48 pb-24 text-read-phone outline-none md:text-read",
      },
      // The caret keeps clear of the formatting bar when typing scrolls the page.
      scrollMargin: { top: 8, bottom: 96, left: 8, right: 8 },
      scrollThreshold: { top: 8, bottom: 96, left: 8, right: 8 },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.getMarkdown().trim();
      if (md === known.current) return;
      known.current = md;
      cb.current.onChange(md);
    },
    onBlur: () => cb.current.onBlur?.(),
    onCreate: ({ editor: ed }) => {
      // Decided and focused in one step, so a keystroke in the title is never taken from under the person.
      if (focusOnCreate.current && !typingElsewhere()) {
        ed.commands.setTextSelection(ed.state.doc.content.size);
        ed.view.focus();
      }
      focusOnCreate.current = false;
    },
  });

  useEffect(() => {
    if (!editor) return;
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    // The text getting its focus back is the link form being done with, however it ended.
    const back = () => setLinkOpen(false);
    editor.on("focus", on);
    editor.on("blur", off);
    editor.on("focus", back);
    return () => {
      editor.off("focus", on);
      editor.off("blur", off);
      editor.off("focus", back);
    };
  }, [editor]);

  const slash = useSlashMenu(editor, { embeds, canUpload: !!upload, onAddProperty, pickFiles: () => files.current?.click() }, box);
  cb.current.slashKey = slash.onKey;
  const mention = useMentionPicker(editor, people, box);
  cb.current.mentionKey = mention.onKey;

  if (!editor) return null;

  const bar = phone && (focused || linkOpen || slash.open);
  return (
    <div ref={box} className="relative">
      <EditorContent editor={editor} />
      {mention.open && people && <MentionPicker id={mention.listId} matches={mention.matches} people={people} active={mention.active} onChoose={mention.choose} style={mention.style} />}
      {!phone && <SlashMenuList menu={slash} />}
      {!phone && <SelectionBubble editor={editor} box={box} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />}
      {upload && (
        <input
          ref={files}
          type="file"
          multiple
          tabIndex={-1}
          aria-label="Media files"
          className="sr-only"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (picked.length > 0) editor.chain().focus().uploadMedia(picked).run();
          }}
        />
      )}
      {bar && createPortal(<FormatBar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} onAddBlock={slash.openAtCaret} menu={<SlashMenuList menu={slash} docked />} />, document.body)}
    </div>
  );
}
