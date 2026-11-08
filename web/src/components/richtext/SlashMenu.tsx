/**
 * The page's block menu (REC-5): `/` at the start of a block (or after a space) lists the blocks, typing narrows
 * them, and Enter or a tap makes the one highlighted. The editor keeps the focus the whole time and points at the
 * highlighted row with `aria-activedescendant`, like the mention list.
 *
 * Linked records and View take a second step, the property or the saved view to embed; a collection with only
 * one of either skips it. The phone's "+" opens the same menu at the caret with no slash typed (`openAtCaret`).
 */
import { useEffect, useId, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { Icon } from "@/components/ui/icon";
import { ListboxOption, useListNav } from "@/components/ui/listbox";
import { menuSurfaceClass } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { anchorStyle } from "./anchor";
import { BLOCKS, insertEmbed, matchBlocks, runBlock, type BlockDef, type Embed, type Range } from "./blocks";
import { dismissSlash, slashQuery, type SlashQuery } from "./slash";

/** What the collection can embed: this record's link properties and the saved views the person may pick (each with the collection it shows). */
export interface EmbedChoices {
  linkFields: readonly { id: string; name: string }[];
  views: readonly { id: string; name: string; collection: string }[];
}

export interface SlashContext {
  embeds: EmbedChoices;
  /** Files can be added (the page has somewhere to keep them). */
  canUpload: boolean;
  /** Opens the box that adds a property to the record; absent when the person cannot add properties. */
  onAddProperty?: () => void;
  /** Opens the file picker. */
  pickFiles: () => void;
}

interface Row {
  id: string;
  label: string;
  block?: BlockDef;
  hint?: string;
  detail?: string;
  disabled?: boolean;
  choose: () => void;
}

/** After a first choice that needs a second one: which, and where the menu stays. */
type Step = { kind: "all" | "linked" | "view"; pos: number };

export interface SlashMenuState {
  open: boolean;
  rows: Row[];
  active: number;
  listId: string;
  title: string;
  /** Where the list sits next to the text (desktop); undefined when it is not showing. */
  style: CSSProperties | undefined;
  choose: (index: number) => void;
  hover: (index: number) => void;
  onKey: (e: KeyboardEvent) => boolean;
  openAtCaret: () => void;
  close: () => void;
}

export function useSlashMenu(editor: Editor | null, ctx: SlashContext, box: RefObject<HTMLDivElement | null>): SlashMenuState {
  const listId = useId();
  const [query, setQuery] = useState<SlashQuery | null>(null);
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    if (!editor) return;
    const follow = () => {
      const next = editor.isInitialized && editor.isFocused ? slashQuery(editor.state) : null;
      setQuery((q) => (q?.from === next?.from && q?.to === next?.to && q?.query === next?.query ? q : next));
    };
    follow();
    // Anything typed, or the focus going elsewhere, ends a step that has no slash holding it open.
    const leave = ({ transaction }: { transaction: { docChanged: boolean } }) => transaction.docChanged && setStep(null);
    const blur = () => setStep(null);
    editor.on("transaction", follow);
    editor.on("transaction", leave);
    editor.on("focus", follow);
    editor.on("blur", follow);
    editor.on("blur", blur);
    return () => {
      editor.off("transaction", follow);
      editor.off("transaction", leave);
      editor.off("focus", follow);
      editor.off("blur", follow);
      editor.off("blur", blur);
    };
  }, [editor]);

  const { embeds } = ctx;
  const run = (def: BlockDef, range: Range) => {
    if (!editor) return;
    switch (def.id) {
      // These two hand the focus to something else (the file dialog, the Add property box): the editor is not
      // told to focus, because that finishes a frame later and would take it back.
      case "file":
        editor.chain().deleteRange(range).run();
        ctx.pickFiles();
        break;
      case "property":
        editor.chain().deleteRange(range).run();
        ctx.onAddProperty?.();
        break;
      case "linked":
      case "view": {
        const choices = def.id === "linked" ? embeds.linkFields : embeds.views;
        const only = choices.length === 1 ? choices[0] : undefined;
        if (only) {
          insertEmbed(editor, def.id === "linked" ? { embed: "linked", field: only.id } : { embed: "view", view: only.id, limit: 10 }, range);
        } else {
          editor.chain().focus().deleteRange(range).run();
          setStep({ kind: def.id, pos: range.from });
        }
        break;
      }
      default:
        runBlock(editor, def.id, range);
    }
  };

  const rows = useMemo<Row[]>(() => {
    if (!editor) return [];
    const embed = (e: Embed, at: number) => () => {
      setStep(null);
      insertEmbed(editor, e, { from: at, to: at });
    };
    if (step?.kind === "linked") {
      return embeds.linkFields.map((f) => ({ id: f.id, label: f.name, choose: embed({ embed: "linked", field: f.id }, step.pos) }));
    }
    if (step?.kind === "view") {
      return embeds.views.map((v) => ({ id: v.id, label: v.name, hint: v.collection, choose: embed({ embed: "view", view: v.id, limit: 10 }, step.pos) }));
    }
    const range: Range = step ? { from: step.pos, to: step.pos } : query ? { from: query.from, to: query.to } : { from: 0, to: 0 };
    if (!step && !query) return [];
    const available = BLOCKS.filter((b) => b.id !== "file" || ctx.canUpload);
    return matchBlocks(available, step ? "" : (query?.query ?? "")).map((block) => {
      let detail: string | undefined;
      if (block.id === "linked" && embeds.linkFields.length === 0) detail = "This collection has no link properties";
      if (block.id === "view" && embeds.views.length === 0) detail = "There are no saved views to show";
      if (block.id === "property" && !ctx.onAddProperty) detail = "Only creators can add properties";
      return { id: block.id, label: block.label, block, hint: block.shortcut, detail, disabled: !!detail, choose: () => run(block, range) };
    });
    // `run` only reads the latest ctx and embeds, which are in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, step, query, embeds, ctx.canUpload, ctx.onAddProperty, ctx.pickFiles]);

  const open = rows.length > 0;
  const nav = useListNav(rows.map((r) => r.id));
  const title = step?.kind === "linked" ? "Link property to show" : step?.kind === "view" ? "View to show" : "Blocks";

  const choose = (index: number) => {
    const row = rows[index];
    if (row && !row.disabled) row.choose();
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (!editor || !open) return false;
    if (e.key === "Escape") {
      if (step) setStep(null);
      else editor.view.dispatch(dismissSlash(editor.state));
      return true;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
    if (nav.onKeyDown(e as unknown as ReactKeyboardEvent)) return true;
    if (e.key === "Enter" || e.key === "Tab") {
      choose(nav.index);
      return true;
    }
    return false;
  };

  // The editor is the combobox: it keeps the focus while the list shows.
  useEffect(() => {
    if (!editor?.isInitialized || editor.isDestroyed) return;
    const dom = editor.view.dom;
    if (open) {
      dom.setAttribute("aria-autocomplete", "list");
      dom.setAttribute("aria-expanded", "true");
      dom.setAttribute("aria-controls", listId);
      if (nav.index >= 0) dom.setAttribute("aria-activedescendant", `${listId}-${nav.index}`);
    } else if (dom.getAttribute("aria-controls") === listId) {
      // Only undo what this list set: the mention list uses the same attributes while it is the one showing.
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
      dom.setAttribute("aria-expanded", "false");
    }
  }, [editor, open, listId, nav.index]);

  const anchor = step?.pos ?? query?.from;
  const style = open && editor?.isInitialized && anchor !== undefined && box.current ? anchorStyle(editor, box.current, anchor, 288) : undefined;

  return {
    open,
    rows,
    active: nav.index,
    listId,
    title,
    style,
    choose,
    hover: nav.setActive,
    onKey,
    openAtCaret: () => editor && setStep({ kind: "all", pos: editor.state.selection.from }),
    close: () => setStep(null),
  };
}

/**
 * The rows. Beside the text on a desktop (`style` places it); on a phone `docked` makes it a panel that sits
 * on top of the formatting bar, above the keyboard.
 */
export function SlashMenuList({ menu, docked }: { menu: SlashMenuState; docked?: boolean }) {
  if (!menu.open) return null;
  return (
    <div
      id={menu.listId}
      role="listbox"
      aria-label={menu.title}
      style={docked ? undefined : menu.style}
      className={cn(menuSurfaceClass, "overflow-y-auto overscroll-contain", docked ? "max-h-[40dvh] w-full rounded-b-none border-x-0 border-b-0 shadow-none" : "absolute z-30 max-h-80 w-72")}
    >
      {menu.rows.map((row, i) => (
        <ListboxOption
          key={row.id}
          id={`${menu.listId}-${i}`}
          active={i === menu.active}
          disabled={row.disabled}
          onSelect={() => menu.choose(i)}
          onHover={() => menu.hover(i)}
          leading={row.block ? <Icon icon={row.block.icon} className="text-muted" /> : undefined}
          hint={row.hint}
          detail={row.detail}
        >
          {row.label}
        </ListboxOption>
      ))}
    </div>
  );
}
