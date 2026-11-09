/** The cards of a shared gallery and board: the signed-in views' own `CardBody` and `KanbanBoard`, with nothing that edits. */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Field, TableRecord } from "@/api/types";
import { CardBody } from "@/views/common/CardBody";
import { cardTitle as cardTitleOf, isDescriptionField } from "@/views/common/cardFields";
import { KanbanBoard } from "@/views/kanban/KanbanBoard";
import { buildStacks, stackKind } from "@/views/kanban/stacks";
import { displayShapeOf } from "@/lib/cells/kinds";
import { useShare } from "./ShareContext";

export interface CardFields {
  title: Field | undefined;
  /** Fields shown under the title (already without the title, cover, description and stack fields). */
  rest: readonly Field[];
  cover?: Field;
  /** Text drawn under the title as a clamped preview (boards). */
  description?: Field;
}

const NO_EMAILS: ReadonlyMap<string, string> = new Map();
/**
 * Which fields a card shows: everything visible except the title, the cover, the description and
 * (on boards) the stack field. `list` holds only the shared fields, so a description the view hides
 * (which the server never names) cannot appear.
 */
export function cardFieldsFor(list: readonly Field[], title: Field | undefined, coverId: string | null | undefined, exclude: ReadonlySet<string> = new Set(), descriptionId?: string | null): CardFields {
  const cover = list.find((f) => f.id === coverId && f.type === "attachment");
  const description = list.find((f) => f.id === descriptionId && f.id !== title?.id && isDescriptionField(f));
  const rest = list.filter((f) => f.id !== title?.id && f.id !== cover?.id && f.id !== description?.id && !exclude.has(f.id) && displayShapeOf(f) !== "button");
  return { title, rest, cover, description };
}

const GALLERY_STEP = 60;
/** The signed-in gallery's card limit and grid (views/gallery/GalleryView). */
const GALLERY_FIELD_LIMIT = 5;

export function PublicGallery({ records, fields, colors, fit }: { records: readonly TableRecord[]; fields: CardFields; colors: Readonly<Record<string, string>>; fit: "cover" | "contain" }) {
  const { format } = useShare();
  const [shown, setShown] = useState(GALLERY_STEP);
  const visible = records.slice(0, shown);
  return (
    <div>
      <ul aria-label="Records" className="grid list-none items-start gap-3.5 p-0" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
        {visible.map((r) => (
          <li key={r.id}>
            <article data-record-id={r.id} aria-label={cardTitleOf(fields.title, r, format)} className="relative block w-full overflow-hidden rounded-lg border border-line bg-surface text-left">
              <CardBody record={r} primary={fields.title} fields={fields.rest} coverField={fields.cover} descriptionField={fields.description} coverFit={fit} coverHeight={132} layout="stacked" format={format} emails={NO_EMAILS} color={colors[r.id]} limit={GALLERY_FIELD_LIMIT} />
            </article>
          </li>
        ))}
      </ul>
      {records.length === 0 && <p className="py-10 text-center text-label text-muted">No records to show.</p>}
      {records.length > shown && (
        <div className="mt-4 text-center">
          <Button onClick={() => setShown((n) => n + GALLERY_STEP)}>Show more ({records.length - shown} left)</Button>
        </div>
      )}
    </div>
  );
}

const noop = () => {};

/** A board of read-only stacks: the signed-in board, told it only shows. The stack field must be a single select, single user or checkbox. */
export function PublicKanban({ stackField, hideEmpty, stackOrder = [], hiddenStacks = [], cardFieldLimit, coverFit = false, records, fields, colors }: {
  stackField: Field;
  hideEmpty: boolean;
  /** The view's stack order and hidden stacks (the server leaves these empty for person stacks). */
  stackOrder?: readonly string[];
  hiddenStacks?: readonly string[];
  cardFieldLimit?: number;
  coverFit?: boolean;
  records: readonly TableRecord[];
  fields: CardFields;
  colors: Readonly<Record<string, string>>;
}) {
  const { format } = useShare();
  const stacks = useMemo(
    () => (stackKind(stackField) ? buildStacks(stackField, records, { stackOrder, hideEmpty, hiddenStacks, people: [] }) : []),
    [stackField, records, hideEmpty, stackOrder, hiddenStacks],
  );
  // Folding a stack is the visitor's own and nothing is saved.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  return (
    <KanbanBoard
      readOnly
      stacks={stacks}
      primary={fields.title}
      fields={fields.rest}
      coverField={fields.cover}
      descriptionField={fields.description}
      cardLimit={cardFieldLimit}
      coverFit={coverFit ? "contain" : "cover"}
      format={format}
      emails={NO_EMAILS}
      colors={colors}
      canEdit={false}
      hasSorts={false}
      collapsed={collapsed}
      onToggleCollapse={(key) => setCollapsed((cur) => (cur.has(key) ? new Set([...cur].filter((k) => k !== key)) : new Set([...cur, key])))}
      onMoveStack={noop}
      onDrop={noop}
      onAddCard={noop}
      newLabel=""
      onOpen={noop}
      onDeleteRecords={noop}
      onDuplicateRecords={noop}
      onMoveRecords={noop}
    />
  );
}
