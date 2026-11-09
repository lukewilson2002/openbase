/**
 * The head of a record page (REC-2): a tile in the collection's pastel hue with the title's initials (the record's
 * own picture when it has one), and the title, the primary property, as the page's one `h1`, edited in place.
 *
 * - Enter commits the title and moves on to the page; Escape gives up the change. A title that does not parse
 *   (a number that is not one) stays, with its message under it, to be corrected.
 * - A computed title, or a primary property that needs an editor of its own (a choice, a date), is a plain
 *   heading: see `titleModeOf`.
 * - Viewers and commenters read the title as text.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { attachmentsApi } from "@/api/records";
import type { Field, Table, TableRecord, View } from "@/api/types";
import { editText, type FormatCtx } from "@/lib/cells/format";
import { cn } from "@/lib/cn";
import { choiceClass } from "@/lib/colors";
import { workspaceColor } from "@/lib/workspaceColor";
import { recordInitials, tileImage, type TitleMode } from "./properties";
import type { RecordSave } from "./useRecordSave";

const TITLE = "text-record-phone md:text-record";

function Tile({ table, record, title, layout }: { table: Table; record: TableRecord; title: string; layout: View["config"] | undefined }) {
  const image = tileImage(table, record.values, layout);
  const [broken, setBroken] = useState<string | null>(null);
  const shown = image && broken !== image.id ? image : null;
  return (
    <span aria-hidden className={cn("mb-4 flex size-10 shrink-0 select-none items-center justify-center overflow-hidden rounded-tile text-h3 font-semibold md:size-11", choiceClass(workspaceColor(table)))}>
      {shown ? <img src={attachmentsApi.thumbUrl(shown.id)} alt="" draggable={false} onError={() => setBroken(shown.id)} className="size-full object-cover" /> : recordInitials(title)}
    </span>
  );
}

export interface RecordHeadProps {
  table: Table;
  record: TableRecord;
  primary: Field | undefined;
  mode: TitleMode;
  /** The title as the breadcrumb says it ("Untitled record" when there is none). */
  title: string;
  readOnly: boolean;
  format: FormatCtx;
  save: RecordSave;
  /** The collection's default view, whose property order decides which attachment property gives the tile its picture. */
  layoutView?: View | null;
  /** The record was just added: the title starts focused (REC-8). */
  autoFocus: boolean;
  /** Enter in the title. */
  onEnter(): void;
  /** Escape in a title with nothing in it, for a record just added: leaving takes the record back (REC-8). */
  onEscapeWhenEmpty?: () => void;
}

export function RecordHead({ table, record, primary, mode, title, readOnly, format, save, layoutView, autoFocus, onEnter, onEscapeWhenEmpty }: RecordHeadProps) {
  const editable = mode === "inline" && !readOnly && !!primary;
  return (
    <div className="mb-6">
      <Tile table={table} record={record} title={title === "Untitled record" ? "" : title} layout={layoutView?.config} />
      {editable ? (
        <TitleInput key={record.id} field={primary} record={record} format={format} save={save} autoFocus={autoFocus} onEnter={onEnter} onEscapeWhenEmpty={onEscapeWhenEmpty} label={title} />
      ) : (
        <h1 className={cn("break-words", TITLE)}>{title}</h1>
      )}
    </div>
  );
}

function TitleInput({ field, record, format, save, autoFocus, onEnter, onEscapeWhenEmpty, label }: { field: Field; record: TableRecord; format: FormatCtx; save: RecordSave; autoFocus: boolean; onEnter(): void; onEscapeWhenEmpty?: () => void; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const failed = save.failed[field.id];
  const seed = editText(field, failed ? (failed.value as never) : (record.values[field.id] ?? null), format);
  // What is typed, until the record has it (or it is given up).
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? seed;
  const error = save.errors[field.id];
  const giveUp = useRef(false);
  // Enter commits and moves the focus away, which commits again: the text is saved once.
  const sent = useRef<string | null>(null);

  // The record changed under the title (someone else's edit, the answer to our own save): it is the truth again,
  // unless the title is being worked on.
  useEffect(() => {
    if (document.activeElement !== ref.current) setTyped(null);
  }, [seed]);

  // The box is as tall as the title: a long one wraps onto more lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    if (autoFocus && el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [autoFocus]);

  const commit = () => {
    if (giveUp.current) {
      giveUp.current = false;
      return;
    }
    if (typed === null || sent.current === typed) return;
    sent.current = typed;
    // Nothing changed: back to the record's text. A refused one stays for the person to correct.
    if (!save.onSave(field, { text: typed }) && typed.trim() === seed.trim()) setTyped(null);
  };

  // Leaving the page by the browser's Back (or a swipe) removes the box without a blur, so what is still being
  // typed is committed as the box goes: for a record just added this is what keeps it from being taken back as empty.
  const pending = useRef({ commit });
  pending.current = { commit };
  useEffect(() => () => pending.current.commit(), []);

  return (
    <>
      <h1 aria-label={label} className={cn("break-words", TITLE)}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          aria-label={field.name}
          aria-invalid={error ? true : undefined}
          placeholder="Untitled"
          onChange={(e) => {
            sent.current = null;
            setTyped(e.target.value.replace(/\s*\n\s*/g, " "));
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
              onEnter();
            } else if (e.key === "Escape") {
              // A record just added with no title typed has nothing to give up: Escape leaves, and the page takes it back.
              if (onEscapeWhenEmpty && text.trim() === "") {
                e.preventDefault();
                onEscapeWhenEmpty();
                return;
              }
              // Gives up the change; a second Escape leaves the page.
              giveUp.current = typed !== null;
              setTyped(null);
              e.currentTarget.blur();
            }
          }}
          // The heading carries the title's size and weight; the box takes them over so the caret and the text agree.
          className="m-0 block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-[inherit] leading-[inherit] tracking-[inherit] text-fg placeholder:text-faint"
        />
      </h1>
      {error && (
        <p role="alert" className="mt-1 text-meta text-danger">
          {error}
        </p>
      )}
    </>
  );
}
