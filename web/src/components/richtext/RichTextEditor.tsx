/**
 * WYSIWYG editor for rich text: Tiptap on top, plain Markdown stored. `value` goes in as
 * Markdown and `onChange` reports Markdown, so the field's value stays readable by people, the API
 * and agents. Loaded lazily (FieldEditor imports it with React.lazy) so Tiptap is its own chunk.
 *
 * With an `upload` function the editor takes files: a toolbar button, paste and drop each add a media
 * block (an image, video, audio or other file; see media.ts). Without it files cannot be added.
 *
 * With `people` the editor mentions: typing `@` offers the people whose name (or email) starts what
 * follows, and picking one inserts a mention (mention.ts), stored as `@[Name](usrXXXX)`. The server
 * notifies them once the text is on a record they can see.
 *
 * The expand button at the bottom-right of the box opens the same editor full screen; the two
 * share the value through the caller, and whichever is not being typed in follows it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Maximize2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import type { AttachmentRef } from "@/api/types";
import { FullScreen } from "@/components/record/editors/FullScreen";
import { useToastIfAny } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { richTextExtensions } from "./extensions";
import { MentionPicker, type MentionPerson } from "./MentionPicker";
import { typingElsewhere, useMentionPicker } from "./useMentionPicker";
import { Toolbar, toolbarControls } from "./Toolbar";

export interface RichTextEditorProps {
  /** Markdown. */
  value: string;
  /** Called with the Markdown after every edit. */
  onChange(md: string): void;
  /** Focus left the editor (not for a click on its own toolbar). */
  onBlur?(): void;
  autoFocus?: boolean;
  /** Fills its container and scrolls inside it, with no expand button (the full-screen view itself). */
  fullScreen?: boolean;
  placeholder?: string;
  /** Uploads a file to where it will be kept and answers its reference. Without it there is no way to add files. */
  upload?: (file: File) => Promise<AttachmentRef>;
  /** Who can be mentioned (the people who can see the project). Without it `@` is only a character. */
  people?: readonly MentionPerson[];
  /** A smaller box (the comment composer). */
  compact?: boolean;
  "aria-label"?: string;
}

export function RichTextEditor({ value, onChange, onBlur, autoFocus, fullScreen, placeholder, upload, people, compact, "aria-label": label }: RichTextEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const toast = useToastIfAny();
  // Callbacks change every render; the editor is created once and reads the latest through this.
  const cb = useRef({ onChange, onBlur, upload, toast, mentionKey: ((_e: KeyboardEvent) => false) as (e: KeyboardEvent) => boolean });
  cb.current = { ...cb.current, onChange, onBlur, upload, toast };
  const canMention = !!people;
  const extensions = useMemo(
    () =>
      richTextExtensions(
        placeholder,
        {
          upload: () => cb.current.upload,
          onError: (file, e) => cb.current.toast?.toast({ title: `${file.name} was not added`, description: errorMessage(e), variant: "error", durationMs: 8000 }),
        },
        canMention ? { onKeyDown: (e) => cb.current.mentionKey(e) } : undefined,
      ),
    [placeholder, canMention],
  );
  // The Markdown the editor last produced or was given: a `value` equal to it is our own echo.
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
        ...(label ? { "aria-label": label } : {}),
        class: cn("ob-prose ob-editor outline-none", fullScreen ? "min-h-full px-4 py-3" : compact ? "min-h-[4.5rem] px-2.5 py-2 pb-10" : "min-h-[8rem] px-2.5 py-2 pb-10"),
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.getMarkdown().trim();
      if (md === known.current) return;
      known.current = md;
      cb.current.onChange(md);
    },
    onBlur: () => cb.current.onBlur?.(),
    // Focused here rather than through Tiptap's `autofocus` or `focus` command, which move the focus a
    // frame later: the editor is ready a moment after the page (its chunk may arrive later still), and by
    // then the person may be typing somewhere else (a title above it). Deciding and focusing in one step
    // never takes the focus from under their keystrokes.
    onCreate: ({ editor: ed }) => {
      if (focusOnCreate.current && !typingElsewhere()) {
        ed.commands.setTextSelection(ed.state.doc.content.size);
        ed.view.focus();
      }
      focusOnCreate.current = false;
    },
  });

  // A value that did not come from this editor (the other view of the field, a refresh) replaces the document.
  useEffect(() => {
    if (!editor || value === known.current) return;
    known.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [value, editor]);

  const box = useRef<HTMLDivElement>(null);
  const mention = useMentionPicker(editor, people, box);
  cb.current.mentionKey = mention.onKey;

  if (!editor) return null;

  return (
    <div
      ref={box}
      className={cn("relative flex flex-col text-[0.8125rem] leading-relaxed", fullScreen ? "min-h-0 flex-1 overflow-y-auto overscroll-contain" : "rounded-md border border-line-strong bg-surface focus-within:border-ring")}
      onKeyDown={(e) => {
        // Escape closes the list of people, not the field's edit or the dialog around the editor. Handled
        // here, not in the editor: a dialog has already marked it handled, and ProseMirror skips those.
        if (e.key === "Escape" && mention.open) {
          e.stopPropagation();
          mention.dismiss();
          return;
        }
        // Alt+F10 goes to the toolbar (its controls are out of the Tab order, so Tab lands in the text).
        if (e.altKey && e.key === "F10") {
          e.preventDefault();
          const toolbar = e.currentTarget.querySelector('[role="toolbar"]');
          if (toolbar) toolbarControls(toolbar)[0]?.focus();
          return;
        }
        // Ctrl/Cmd+K is "link" in every editor; the toolbar's button owns the popover.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-label="Link"]')?.click();
        }
      }}
    >
      <Toolbar editor={editor} canUpload={!!upload} />
      <EditorContent editor={editor} className={fullScreen ? "flex-1" : undefined} />
      {mention.open && people && <MentionPicker id={mention.listId} matches={mention.matches} people={people} active={mention.active} onChoose={mention.choose} style={mention.style} />}
      {!fullScreen && (
        // Zero-height strip that sticks to the bottom of the visible part of the box, so the button
        // stays in reach however long the document grows.
        <div className="pointer-events-none sticky bottom-0 h-0">
          <button
            type="button"
            aria-label="Open full screen"
            title="Open full screen"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setExpanded(true)}
            className="pointer-events-auto absolute bottom-2 right-2 inline-flex size-8 max-md:size-control-touch pointer-coarse:size-control-touch items-center justify-center rounded-md border border-line bg-surface text-muted shadow-pop hover:bg-hover hover:text-fg"
          >
            <Maximize2 aria-hidden className="size-4" />
          </button>
        </div>
      )}
      {expanded && (
        <FullScreen title={label ?? "Edit text"} onClose={() => setExpanded(false)}>
          <RichTextEditor value={value} onChange={onChange} onBlur={onBlur} autoFocus fullScreen placeholder={placeholder} upload={upload} people={people} aria-label={label} />
        </FullScreen>
      )}
    </div>
  );
}
