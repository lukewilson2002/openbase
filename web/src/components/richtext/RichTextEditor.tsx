/**
 * WYSIWYG editor for rich long text: Tiptap on top, plain Markdown stored. `value` goes in as
 * Markdown and `onChange` reports Markdown, so the field's value stays readable by people, the API
 * and agents. Loaded lazily (FieldEditor imports it with React.lazy) so Tiptap is its own chunk.
 *
 * The expand button at the bottom-right of the box opens the same editor full screen; the two
 * share the value through the caller, and whichever is not being typed in follows it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Maximize2 } from "lucide-react";
import { FullScreen } from "@/components/record/editors/FullScreen";
import { cn } from "@/lib/cn";
import { richTextExtensions } from "./extensions";
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
  "aria-label"?: string;
}

/** Whether a text box, or anything else that takes typing, has the focus already. */
function typingElsewhere(): boolean {
  const el = document.activeElement;
  return !!el && el !== document.body && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
}

export function RichTextEditor({ value, onChange, onBlur, autoFocus, fullScreen, placeholder, "aria-label": label }: RichTextEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const extensions = useMemo(() => richTextExtensions(placeholder), [placeholder]);
  // Callbacks change every render; the editor is created once and reads the latest through this.
  const cb = useRef({ onChange, onBlur });
  cb.current = { onChange, onBlur };
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
        class: cn("ob-prose ob-editor outline-none", fullScreen ? "min-h-full px-4 py-3" : "min-h-[8rem] px-2.5 py-2 pb-10"),
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

  if (!editor) return null;

  return (
    <div
      className={cn("relative flex flex-col text-[0.8125rem] leading-relaxed", fullScreen ? "min-h-0 flex-1 overflow-y-auto overscroll-contain" : "rounded-md border border-line-strong bg-surface focus-within:border-ring")}
      onKeyDown={(e) => {
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
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className={fullScreen ? "flex-1" : undefined} />
      {!fullScreen && (
        // Zero-height strip that sticks to the bottom of the visible part of the box, so the button
        // stays in reach however long the document grows.
        <div className="pointer-events-none sticky bottom-2 h-0">
          <button
            type="button"
            aria-label="Open full screen"
            title="Open full screen"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setExpanded(true)}
            className="pointer-events-auto absolute bottom-0 right-2 inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md border border-line bg-surface text-muted shadow-pop hover:bg-hover hover:text-fg"
          >
            <Maximize2 aria-hidden className="size-4" />
          </button>
        </div>
      )}
      {expanded && (
        <FullScreen title={label ?? "Edit text"} onClose={() => setExpanded(false)}>
          <RichTextEditor value={value} onChange={onChange} onBlur={onBlur} autoFocus fullScreen placeholder={placeholder} aria-label={label} />
        </FullScreen>
      )}
    </div>
  );
}
