/**
 * The formatting toolbar of the rich text editor. It sticks to the top of the editor, scrolls
 * sideways when it does not fit (phones), and its buttons grow to 40px on touch. Buttons keep the
 * editor's focus (mousedown is not allowed to move it), so the on-screen keyboard stays up; the
 * menus hand focus back to the editor when they close.
 *
 * Its controls are out of the Tab order, so tabbing into a field lands in the text. The keyboard
 * reaches the toolbar with Alt+F10 from the text (as in most editors), moves along it with the
 * arrow keys, Home and End, and goes back to the text with Escape.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  CheckSquare,
  ChevronDown,
  Code,
  Code2,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Strikethrough,
  Table2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { CALLOUT_KINDS, CALLOUT_LABELS, type CalloutKind } from "./callout";

// A grid cell editor closes on a click outside of it; the editor's menus render in portals.
const KEEP_GRID_EDITOR = "click-outside-ignore";

const btn =
  "inline-flex size-8 pointer-coarse:size-10 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg " +
  "disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-primary-soft aria-pressed:text-primary-text data-[state=open]:bg-hover";

/** Keeps the editor's selection and keyboard when a toolbar control is pressed. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" tabIndex={-1} aria-label={label} title={label} aria-pressed={active} disabled={disabled} onMouseDown={keepFocus} onClick={onClick} className={btn}>
      {children}
    </button>
  );
}

/** The toolbar's controls a keyboard can move to, in order. */
export function toolbarControls(toolbar: Element): HTMLButtonElement[] {
  return [...toolbar.querySelectorAll<HTMLButtonElement>("button")].filter((b) => !b.disabled);
}

/** Arrow keys, Home and End move along the toolbar (Escape is `useEscapeBack`). */
function moveAlong(e: React.KeyboardEvent<HTMLDivElement>) {
  // Keys inside an open menu or popover belong to it (they render in portals, but bubble through React).
  if (!e.currentTarget.contains(e.target as Node)) return;
  const controls = toolbarControls(e.currentTarget);
  const at = controls.indexOf(e.target as HTMLButtonElement);
  if (at < 0) return;
  const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? controls.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  controls[(next + controls.length) % controls.length]?.focus();
}

/**
 * Escape on a toolbar control goes back to the text. Caught on the window before anything else: a
 * dialog around the editor (an open record, full screen) listens for Escape on the document in its
 * capture phase and would close itself instead.
 */
function useEscapeBack(ref: RefObject<HTMLDivElement | null>, editor: Editor) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !ref.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // At once (the `focus` command waits a frame), with the selection where it was.
      editor.view.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ref, editor]);
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line" />;
}

/** Closing a menu puts the caret back in the document rather than on the menu's button. */
const refocus = (editor: Editor) => (e: Event) => {
  e.preventDefault();
  editor.commands.focus();
};

const HEADINGS = [1, 2, 3, 4, 5, 6] as const;

function ToolMenu({ editor, label, trigger, children, className }: { editor: Editor; label: string; trigger: ReactNode; children: ReactNode; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" tabIndex={-1} aria-label={label} title={label} onMouseDown={keepFocus} className={cn(btn, className)}>
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={KEEP_GRID_EDITOR} onCloseAutoFocus={refocus(editor)}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A link is added to the selection (or to a new piece of text) from a small popover. */
function LinkButton({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const onOpenChange = (o: boolean) => {
    if (o) {
      setHref((editor.getAttributes("link").href as string | undefined) ?? "");
      setError(null);
    }
    setOpen(o);
  };

  const apply = () => {
    let url = href.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setOpen(false);
      return;
    }
    // "example.com" is an address, not a relative link; anything else must carry a scheme we allow.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("/") && !url.startsWith("#")) url = `https://${url}`;
    if (!/^(?:https?:|mailto:|tel:|\/(?!\/)|#)/i.test(url)) {
      setError("Use a web address, an email address (mailto:) or a phone number (tel:).");
      return;
    }
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" tabIndex={-1} aria-label="Link" title="Link (Ctrl+K)" aria-pressed={active} onMouseDown={keepFocus} className={btn}>
          <Link2 aria-hidden className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("flex w-80 flex-col gap-2", KEEP_GRID_EDITOR)}
        onCloseAutoFocus={refocus(editor)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
      >
        <label htmlFor={inputId} className="text-[0.8125rem] font-medium">
          Link address
        </label>
        <input
          id={inputId}
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          value={href}
          onChange={(e) => {
            setHref(e.target.value);
            setError(null);
          }}
          placeholder="https://"
          aria-invalid={error ? true : undefined}
          className="h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 focus-visible:border-ring aria-[invalid=true]:border-danger"
        />
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {active && (
            <Button
              variant="secondary"
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                setOpen(false);
              }}
            >
              Remove link
            </Button>
          )}
          <Button onClick={apply}>Apply</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Insert media: a file picker whose files are uploaded and added as blocks at the cursor. */
function MediaButton({ editor }: { editor: Editor }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <ToolButton label="Insert media" onClick={() => input.current?.click()}>
        <ImagePlus aria-hidden className="size-4" />
      </ToolButton>
      <input
        ref={input}
        type="file"
        multiple
        tabIndex={-1}
        aria-label="Media files"
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) editor.chain().focus().uploadMedia(files).run();
        }}
      />
    </>
  );
}

export function Toolbar({ editor, canUpload }: { editor: Editor; canUpload?: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const itemType = e.isActive("taskItem") ? "taskItem" : "listItem";
      return {
        heading: HEADINGS.find((l) => e.isActive("heading", { level: l })) ?? 0,
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        link: e.isActive("link"),
        bullet: e.isActive("bulletList"),
        ordered: e.isActive("orderedList"),
        task: e.isActive("taskList"),
        quote: e.isActive("blockquote"),
        callout: e.isActive("callout") ? (e.getAttributes("callout").kind as CalloutKind) : null,
        codeBlock: e.isActive("codeBlock"),
        table: e.isActive("table"),
        headerRow: e.isActive("tableHeader"),
        canIndent: e.can().sinkListItem(itemType),
        canOutdent: e.can().liftListItem(itemType),
        inCode: e.isActive("codeBlock"),
      };
    },
  });
  const run = () => editor.chain().focus();
  const itemType = editor.isActive("taskItem") ? "taskItem" : "listItem";
  const ref = useRef<HTMLDivElement>(null);
  useEscapeBack(ref, editor);

  // `shrink-0`: in the full-screen editor this sits in a scrolling column, where a long document would
  // otherwise squeeze it (it scrolls sideways, so the browser lets it shrink below its buttons).
  // It sticks at `--ob-sticky-top`: where the visible part of the surrounding scroll area starts. A
  // padded scroll area sets it to minus its padding (sticky stops at the padding's inner edge, and
  // the text would show above it); the page under the app's top bar sets it to the bar's height.
  return (
    <div role="toolbar" aria-label="Formatting" aria-orientation="horizontal" ref={ref} onKeyDown={moveAlong} className="sticky top-[var(--ob-sticky-top,0px)] z-10 flex shrink-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-t-md border-b border-line bg-surface px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ToolMenu editor={editor} label="Text style" trigger={<span className="flex items-center gap-1 px-1.5 text-[0.8125rem] text-fg">{s.heading ? `Heading ${s.heading}` : "Paragraph"}<ChevronDown aria-hidden className="size-3.5 text-muted" /></span>} className="w-auto min-w-24 justify-between">
        <DropdownMenuItem onSelect={() => run().setParagraph().run()}>Paragraph</DropdownMenuItem>
        {HEADINGS.map((level) => (
          <DropdownMenuItem key={level} onSelect={() => run().setHeading({ level }).run()}>
            Heading {level}
          </DropdownMenuItem>
        ))}
      </ToolMenu>
      <Divider />
      <ToolButton label="Bold" active={s.bold} onClick={() => run().toggleBold().run()}>
        <Bold aria-hidden className="size-4" />
      </ToolButton>
      <ToolButton label="Italic" active={s.italic} onClick={() => run().toggleItalic().run()}>
        <Italic aria-hidden className="size-4" />
      </ToolButton>
      <ToolButton label="Strikethrough" active={s.strike} onClick={() => run().toggleStrike().run()}>
        <Strikethrough aria-hidden className="size-4" />
      </ToolButton>
      <ToolButton label="Code" active={s.code} onClick={() => run().toggleCode().run()}>
        <Code aria-hidden className="size-4" />
      </ToolButton>
      <LinkButton editor={editor} active={s.link} />
      <Divider />
      <ToolButton label="Bulleted list" active={s.bullet} onClick={() => run().toggleBulletList().run()}>
        <List aria-hidden className="size-4" />
      </ToolButton>
      <ToolButton label="Numbered list" active={s.ordered} onClick={() => run().toggleOrderedList().run()}>
        <ListOrdered aria-hidden className="size-4" />
      </ToolButton>
      <ToolButton label="Task list" active={s.task} onClick={() => run().toggleTaskList().run()}>
        <CheckSquare aria-hidden className="size-4" />
      </ToolButton>
      <ToolButton label="Indent" disabled={!s.canIndent} onClick={() => run().sinkListItem(itemType).run()}>
        <IndentIncrease aria-hidden className="size-4" />
      </ToolButton>
      <ToolButton label="Outdent" disabled={!s.canOutdent} onClick={() => run().liftListItem(itemType).run()}>
        <IndentDecrease aria-hidden className="size-4" />
      </ToolButton>
      <Divider />
      <ToolButton label="Quote" active={s.quote} onClick={() => run().toggleBlockquote().run()}>
        <Quote aria-hidden className="size-4" />
      </ToolButton>
      <ToolMenu editor={editor} label="Callout" trigger={<TriangleAlert aria-hidden className={cn("size-4", s.callout && "text-primary-text")} />}>
        {CALLOUT_KINDS.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => run().setCallout(kind).run()} className={s.callout === kind ? "bg-hover" : undefined}>
            <span aria-hidden className="ob-callout-dot size-2.5 rounded-full" data-callout={kind} />
            {CALLOUT_LABELS[kind]}
          </DropdownMenuItem>
        ))}
        {s.callout && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => run().unsetCallout().run()}>Remove callout</DropdownMenuItem>
          </>
        )}
      </ToolMenu>
      <ToolButton label="Code block" active={s.codeBlock} onClick={() => run().toggleCodeBlock().run()}>
        <Code2 aria-hidden className="size-4" />
      </ToolButton>
      <ToolMenu editor={editor} label="Table" trigger={<Table2 aria-hidden className={cn("size-4", s.table && "text-primary-text")} />}>
        {!s.table ? (
          <DropdownMenuItem onSelect={() => run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Insert table (3 × 3)</DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => run().addRowBefore().run()}>Add row above</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run().addRowAfter().run()}>Add row below</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run().addColumnBefore().run()}>Add column before</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run().addColumnAfter().run()}>Add column after</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => run().toggleHeaderRow().run()}>{s.headerRow ? "Turn header row off" : "Turn header row on"}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => run().deleteRow().run()}>Delete row</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run().deleteColumn().run()}>Delete column</DropdownMenuItem>
            <DropdownMenuItem danger onSelect={() => run().deleteTable().run()}>
              Delete table
            </DropdownMenuItem>
          </>
        )}
      </ToolMenu>
      <ToolButton label="Horizontal rule" onClick={() => run().setHorizontalRule().run()}>
        <Minus aria-hidden className="size-4" />
      </ToolButton>
      {canUpload && <MediaButton editor={editor} />}
    </div>
  );
}
