/**
 * What a board, calendar or timeline shows before it knows which field to use: a heading, one sentence,
 * the property picker(s) with the likely property already chosen, a button that applies them, and a
 * footnote that opens the property dialog when the right one does not exist yet. An empty state: words
 * and one action, no picture, straight on the page's grey.
 */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { Field, FieldType } from "@/api/types";
import { FieldDialog } from "@/components/fields/FieldDialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { atLeast } from "@/lib/roles";
import type { ViewSetup } from "./useViewSetup";

export interface SetupPicker {
  label: ReactNode;
  fields: readonly Field[];
  /** The field chosen at first (the likely one). */
  initial: string;
  /** Label of an empty choice ("No end date"); omit when a field is required. */
  noneLabel?: string;
}

export interface ViewSetupStateProps {
  setup: ViewSetup;
  heading: string;
  /** The sentence under the heading for people who can pick the field. */
  body: string;
  /** Shown instead when no field fits yet, for example "This table has no date field yet." */
  emptyBody: string;
  pickers: readonly SetupPicker[];
  /** The button that applies the choice: beside a single picker, under several. */
  button: string;
  onApply: (ids: (string | null)[]) => void;
  /** "Stacks come from a single select or a person field." */
  footText: string;
  /** "Add a field" / "Add a date field": opens the field dialog with this type chosen. */
  footLink: string;
  addType: FieldType;
  /** Whether a field fits the first picker (a field added from here becomes the choice when it does). */
  accepts: (field: Field) => boolean;
}

export function ViewSetupState({ setup, heading, body, emptyBody, pickers, button, onApply, footText, footLink, addType, accepts }: ViewSetupStateProps) {
  const { schema, table, role } = setup;
  const canAddField = atLeast(role, "creator");
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<string[]>(() => pickers.map((p) => p.initial));
  const ids = useId();
  const usable = pickers[0]!.fields.length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const values = chosen.map((v) => v || null);
    if (values[0]) onApply(values);
  };

  let controls: ReactNode = null;
  if (!usable) {
    controls = canAddField ? (
      <Button variant="primary" size="lg" onClick={() => setAdding(true)}>
        {footLink}
      </Button>
    ) : null;
  } else {
    const pick = (i: number, v: string) => setChosen((c) => c.map((x, k) => (k === i ? v : x)));
    const selectFor = (p: SetupPicker, i: number) => (
      <Select id={`${ids}-${i}`} value={chosen[i] ?? ""} onChange={(e) => pick(i, e.target.value)}>
        {p.noneLabel !== undefined && <option value="">{p.noneLabel}</option>}
        {p.fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </Select>
    );
    const apply = (
      <Button type="submit" variant="primary" size="lg" className="max-md:w-full" disabled={!chosen[0]}>
        {button}
      </Button>
    );
    controls =
      pickers.length === 1 ? (
        <form onSubmit={submit} aria-label={heading} className="flex w-full flex-col gap-2 text-left">
          <label htmlFor={`${ids}-0`} className="text-label font-semibold">
            {pickers[0]!.label}
          </label>
          <div className="flex flex-wrap gap-2.5">
            <div className="min-w-0 flex-[1_1_240px]">{selectFor(pickers[0]!, 0)}</div>
            {apply}
          </div>
        </form>
      ) : (
        <form onSubmit={submit} aria-label={heading} className="flex w-full flex-col gap-4 text-left">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            {pickers.map((p, i) => (
              <div key={i} className="flex flex-col gap-2">
                <label htmlFor={`${ids}-${i}`} className="text-label font-semibold">
                  {p.label}
                </label>
                {selectFor(p, i)}
              </div>
            ))}
          </div>
          <div>{apply}</div>
        </form>
      );
  }

  const sentence = usable ? body : emptyBody;

  return (
    <div className="flex min-h-full justify-center px-4 py-10 sm:px-6 sm:py-14">
      <section aria-labelledby={`${ids}-title`} className="flex w-full max-w-[540px] flex-col items-center gap-6 text-center">
        <div>
          <h2 id={`${ids}-title`} className="mb-2 text-h2">
            {heading}
          </h2>
          <p className="text-ui text-balance text-muted">{sentence}</p>
        </div>
        {controls}
        {usable && (
          <p className="text-label text-muted">
            {footText}
            {canAddField && (
              <>
                {" "}
                <button type="button" onClick={() => setAdding(true)} className="text-primary-text underline underline-offset-2 hover:text-primary-hover">
                  {footLink}
                </button>
              </>
            )}
          </p>
        )}
      </section>
      {adding && (
        <FieldDialog
          state={{ mode: "create", type: addType }}
          schema={schema}
          table={table}
          onOpenChange={(open) => !open && setAdding(false)}
          onSaved={(f) => {
            // A field that fits becomes the choice, so "Add a field" then the button is all it takes.
            if (accepts(f)) setChosen((c) => [f.id, ...c.slice(1)]);
          }}
        />
      )}
    </div>
  );
}
