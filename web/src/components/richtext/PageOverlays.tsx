/**
 * What floats over the page while it is edited (REC-5): the selection bubble on a desktop, and the formatting bar
 * above the keyboard on a phone. Neither takes the focus from the text: a press on a button is cancelled before it
 * can move it, so the selection and the on-screen keyboard stay where they are. The link address is the one thing
 * typed outside the text, in a small form that appears in the bubble (desktop) or on top of the bar (phone).
 */
import { useEffect, useId, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { Bold, Code, IndentDecrease, IndentIncrease, Italic, Link2, List, ListChecks, ListOrdered, Plus, Strikethrough, KeyboardOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { applyLink, currentLink, linkAddress, removeLink } from "./links";

/** A press on a control of the overlay must not move the focus (and so the keyboard) out of the text. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** The address of a link being added or changed. Enter applies it, Escape gives up, and either gives the text its focus back. */
export function LinkForm({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [href, setHref] = useState(() => currentLink(editor));
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const editing = editor.isActive("link");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!href.trim()) {
      if (editing) removeLink(editor);
      else editor.commands.focus();
      onClose();
      return;
    }
    const address = linkAddress(href);
    if (!address.ok) {
      setError(address.error);
      return;
    }
    applyLink(editor, address.href);
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Ctrl+K again stays in the form (selecting the address) rather than falling through to the command palette.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (e.target instanceof HTMLInputElement) e.target.select();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    editor.commands.focus();
    onClose();
  };

  return (
    // The address is checked by `linkAddress` ("example.com" is a fine one); the browser's own URL check would refuse it.
    <form noValidate onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col gap-1.5 p-1">
      <label htmlFor={inputId} className="sr-only">
        Link address
      </label>
      <div className="flex items-center gap-1.5">
        <Input
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
          placeholder="Paste or type a link"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="soft" size="sm">
          Apply
        </Button>
        {editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              removeLink(editor);
              onClose();
            }}
          >
            Remove
          </Button>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="px-1 text-meta text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function Mark({ label, shortcut, active, noTooltip, onClick, children }: { label: string; shortcut?: string; active?: boolean; noTooltip?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton
      label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      noTooltip={noTooltip}
      aria-pressed={active}
      onMouseDown={keepFocus}
      onClick={onClick}
      className="aria-pressed:bg-primary-soft aria-pressed:text-primary-ink"
    >
      {children}
    </IconButton>
  );
}

/** What the selection is, for the buttons that show it. */
function useMarks(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      canIndent: e.can().sinkListItem(e.isActive("taskItem") ? "taskItem" : "listItem"),
      canOutdent: e.can().liftListItem(e.isActive("taskItem") ? "taskItem" : "listItem"),
    }),
  });
}

export interface SelectionBubbleProps {
  editor: Editor;
  /** The editor's positioned container. */
  box: RefObject<HTMLDivElement | null>;
  /** The link form is open (Ctrl+K, or the bubble's link button). */
  linkOpen: boolean;
  onLinkOpenChange: (open: boolean) => void;
}

const BUBBLE_WIDTH = 232;
const LINK_WIDTH = 360;

/** Bold, italic, strike, code and link over the selected text. With Ctrl+K and no selection only the link form shows, at the caret. */
export function SelectionBubble({ editor, box, linkOpen, onLinkOpenChange }: SelectionBubbleProps) {
  const marks = useMarks(editor);
  // The keyboard can move into the bubble (Alt+F10), which takes the focus from the text; it stays while it has it.
  const [inside, setInside] = useState(false);
  // The link form's input goes away without a blur when it is done with: whatever had the focus in here is over.
  useEffect(() => {
    if (!linkOpen) setInside(false);
  }, [linkOpen]);
  const sel = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { selection } = e.state;
      const selectable = !selection.empty && !(selection instanceof NodeSelection) && selection.$from.parent.isTextblock && !e.isActive("codeBlock");
      return { from: selection.from, to: selection.to, selectable, focused: e.isFocused };
    },
  });
  if (!box.current || !(linkOpen || ((sel.focused || inside) && sel.selectable))) return null;

  const width = linkOpen ? LINK_WIDTH : BUBBLE_WIDTH;
  const rect = box.current.getBoundingClientRect();
  let start = { left: rect.left, top: rect.top, bottom: rect.top + 24 };
  let end = start;
  try {
    start = editor.view.coordsAtPos(sel.from);
    end = editor.view.coordsAtPos(sel.to);
  } catch {
    // No layout to measure: the bubble goes at the top left.
  }
  // Over the first line of the selection, centred on it when it is one line; under it when there is no room above.
  const centre = Math.abs(start.top - end.top) < 4 ? (start.left + end.left) / 2 : start.left;
  const left = Math.max(width / 2 + 4, Math.min(centre - rect.left, rect.width - width / 2 - 4));
  const above = start.top > 64;
  const style = above ? { left, top: start.top - rect.top - 8, transform: "translate(-50%, -100%)" } : { left, top: end.bottom - rect.top + 8, transform: "translateX(-50%)" };

  const chain = () => editor.chain().focus();

  return (
    <div
      role={linkOpen ? "group" : "toolbar"}
      aria-label={linkOpen ? "Link" : "Format selection"}
      style={{ ...style, width: linkOpen ? width : undefined }}
      // A press on the bubble's own padding is not a press on the text either.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onFocus={() => setInside(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setInside(false);
      }}
      onKeyDown={(e) => {
        if (linkOpen) return;
        if (e.key === "Escape") {
          // Back to the text, with the selection as it was.
          e.preventDefault();
          e.stopPropagation();
          editor.commands.focus();
          return;
        }
        // The arrows walk along the buttons, as in any toolbar.
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button"));
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        if (at < 0) return;
        e.preventDefault();
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      }}
      className="absolute z-30 max-w-[calc(100%-0.5rem)] rounded-lg border border-line bg-surface p-1 shadow-pop"
    >
      {linkOpen ? (
        <LinkForm editor={editor} onClose={() => onLinkOpenChange(false)} />
      ) : (
        <div className="flex items-center gap-0.5">
          <Mark label="Bold" shortcut="Ctrl+B" noTooltip active={marks.bold} onClick={() => chain().toggleBold().run()}>
            <Icon icon={Bold} />
          </Mark>
          <Mark label="Italic" shortcut="Ctrl+I" noTooltip active={marks.italic} onClick={() => chain().toggleItalic().run()}>
            <Icon icon={Italic} />
          </Mark>
          <Mark label="Strikethrough" noTooltip active={marks.strike} onClick={() => chain().toggleStrike().run()}>
            <Icon icon={Strikethrough} />
          </Mark>
          <Mark label="Code" shortcut="Ctrl+E" noTooltip active={marks.code} onClick={() => chain().toggleCode().run()}>
            <Icon icon={Code} />
          </Mark>
          <Mark label="Link" shortcut="Ctrl+K" noTooltip active={marks.link} onClick={() => onLinkOpenChange(true)}>
            <Icon icon={Link2} />
          </Mark>
        </div>
      )}
    </div>
  );
}

export interface FormatBarProps {
  editor: Editor;
  linkOpen: boolean;
  onLinkOpenChange: (open: boolean) => void;
  /** Opens the block menu at the caret (the phone has no slash key to speak of). */
  onAddBlock: () => void;
  /** The block menu, when it is showing: it sits on top of the bar. */
  menu?: ReactNode;
}

/**
 * The phone's formatting bar: it stands on the keyboard (`useVisualViewport` says where that is), scrolls sideways when
 * it does not fit, and has 44 px buttons. Done puts the keyboard away.
 */
export function FormatBar({ editor, linkOpen, onLinkOpenChange, onAddBlock, menu }: FormatBarProps) {
  const marks = useMarks(editor);
  const area = useVisualViewport();
  const chain = () => editor.chain().focus();
  const itemType = editor.isActive("taskItem") ? "taskItem" : "listItem";
  return (
    <div
      style={{ top: area.top + area.height }}
      // `translateY(-100%)` puts the bar's bottom edge on the keyboard's top edge.
      className="fixed inset-x-0 z-40 -translate-y-full border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      {menu}
      {linkOpen ? (
        <LinkForm editor={editor} onClose={() => onLinkOpenChange(false)} />
      ) : (
        <div role="toolbar" aria-label="Formatting" className="flex items-center gap-0.5 overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Mark label="Add block" noTooltip onClick={onAddBlock}>
            <Icon icon={Plus} />
          </Mark>
          <Divider />
          <Mark label="Bold" noTooltip active={marks.bold} onClick={() => chain().toggleBold().run()}>
            <Icon icon={Bold} />
          </Mark>
          <Mark label="Italic" noTooltip active={marks.italic} onClick={() => chain().toggleItalic().run()}>
            <Icon icon={Italic} />
          </Mark>
          <Mark label="Strikethrough" noTooltip active={marks.strike} onClick={() => chain().toggleStrike().run()}>
            <Icon icon={Strikethrough} />
          </Mark>
          <Mark label="Code" noTooltip active={marks.code} onClick={() => chain().toggleCode().run()}>
            <Icon icon={Code} />
          </Mark>
          <Mark label="Link" noTooltip active={marks.link} onClick={() => onLinkOpenChange(true)}>
            <Icon icon={Link2} />
          </Mark>
          <Divider />
          <Mark label="Bulleted list" noTooltip active={marks.bullet} onClick={() => chain().toggleBulletList().run()}>
            <Icon icon={List} />
          </Mark>
          <Mark label="Numbered list" noTooltip active={marks.ordered} onClick={() => chain().toggleOrderedList().run()}>
            <Icon icon={ListOrdered} />
          </Mark>
          <Mark label="Checklist" noTooltip active={marks.task} onClick={() => chain().toggleTaskList().run()}>
            <Icon icon={ListChecks} />
          </Mark>
          {/* The phone's keyboard has no Tab: these are how a list item moves in and out. */}
          <IconButton label="Indent" noTooltip disabled={!marks.canIndent} onMouseDown={keepFocus} onClick={() => chain().sinkListItem(itemType).run()}>
            <Icon icon={IndentIncrease} />
          </IconButton>
          <IconButton label="Outdent" noTooltip disabled={!marks.canOutdent} onMouseDown={keepFocus} onClick={() => chain().liftListItem(itemType).run()}>
            <Icon icon={IndentDecrease} />
          </IconButton>
          <span className="flex-1" />
          <Divider />
          <IconButton label="Hide keyboard" noTooltip onMouseDown={keepFocus} onClick={() => editor.commands.blur()}>
            <Icon icon={KeyboardOff} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line" />;
}
