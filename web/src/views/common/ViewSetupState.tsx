/**
 * What a kanban, calendar or timeline shows before it knows which field to use: a small picture of
 * the view, a heading, one sentence, the field picker(s) with the likely field already chosen, a
 * button that applies them, and a footnote that opens the field dialog when the right field does not
 * exist yet. Laid out like the empty base, straight on the page's grey.
 */
import { useId, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { Field, FieldType } from "@/api/types";
import { FieldDialog } from "@/components/fields/FieldDialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import type { ViewSetup } from "./useViewSetup";

export type SetupPicture = "kanban" | "calendar" | "timeline";

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
  picture: SetupPicture;
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

const selectClass = "h-[46px] rounded-[10px] pl-3.5 pr-10 text-base";

export function ViewSetupState({ setup, picture, heading, body, emptyBody, pickers, button, onApply, footText, footLink, addType, accepts }: ViewSetupStateProps) {
  const { schema, table, cfg, role } = setup;
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
  if (!cfg.canConfigure) {
    controls = null;
  } else if (!usable) {
    controls = canAddField ? (
      <Button variant="primary" size="lg" className="h-[46px] rounded-[10px] px-5 font-semibold" onClick={() => setAdding(true)}>
        {footLink}
      </Button>
    ) : null;
  } else {
    const pick = (i: number, v: string) => setChosen((c) => c.map((x, k) => (k === i ? v : x)));
    const selectFor = (p: SetupPicker, i: number) => (
      <Select id={`${ids}-${i}`} value={chosen[i] ?? ""} onChange={(e) => pick(i, e.target.value)} className={selectClass}>
        {p.noneLabel !== undefined && <option value="">{p.noneLabel}</option>}
        {p.fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </Select>
    );
    const apply = (
      <Button type="submit" variant="primary" size="lg" className="h-[46px] rounded-[10px] px-5 font-semibold max-[420px]:w-full" disabled={!chosen[0]}>
        {button}
      </Button>
    );
    controls =
      pickers.length === 1 ? (
        <form onSubmit={submit} aria-label={heading} className="flex w-full flex-col gap-2 text-left">
          <label htmlFor={`${ids}-0`} className="text-sm font-semibold">
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
                <label htmlFor={`${ids}-${i}`} className="text-sm font-semibold">
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

  const sentence = !cfg.canConfigure ? `${usable ? "" : `${emptyBody} `}Ask someone who can edit this view to set it up.` : usable ? body : emptyBody;

  return (
    <div className="flex min-h-full justify-center px-4 py-10 sm:px-6 sm:py-14">
      <section aria-labelledby={`${ids}-title`} className="flex w-full max-w-[540px] flex-col items-center gap-[22px] text-center">
        <Picture kind={picture} />
        <div>
          <h2 id={`${ids}-title`} className="mb-2 text-[1.625rem] leading-tight tracking-[-0.015em]">
            {heading}
          </h2>
          <p className="text-base leading-relaxed text-balance text-muted">{sentence}</p>
        </div>
        {controls}
        {cfg.canConfigure && usable && (
          <p className="text-sm text-muted">
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

const CARD = "w-[220px] rounded-2xl border border-line bg-surface p-3.5 shadow-[0_10px_28px_rgb(15_20_30/0.08)]";
const TINT = {
  blue: "bg-[color-mix(in_srgb,var(--primary)_24%,var(--surface))]",
  green: "bg-[color-mix(in_srgb,var(--success)_28%,var(--surface))]",
  yellow: "bg-[color-mix(in_srgb,#d99a00_38%,var(--surface))]",
  plain: "bg-[color-mix(in_srgb,var(--line)_60%,var(--surface))]",
};

/** A small, still picture of the view being set up. */
function Picture({ kind }: { kind: SetupPicture }) {
  let n = 0;
  const piece = (className: string, style?: CSSProperties) => <span key={n++} className={className} style={style} />;
  if (kind === "kanban") {
    const stacks: [keyof typeof TINT, number][] = [
      ["blue", 3],
      ["green", 2],
      ["yellow", 3],
    ];
    return (
      <div aria-hidden className={cn(CARD, "flex items-start gap-1.5")}>
        {stacks.map(([tint, cards], i) => (
          <div key={i} className="flex flex-1 flex-col gap-[5px] rounded-lg bg-subtle p-1.5">
            {piece(cn("h-2 w-[70%] rounded-full", TINT[tint]))}
            {Array.from({ length: cards }, () => piece("h-4 rounded border border-line bg-surface"))}
          </div>
        ))}
      </div>
    );
  }
  if (kind === "calendar") {
    const marks: Record<number, keyof typeof TINT> = { 3: "yellow", 8: "blue", 10: "blue", 11: "green", 17: "green" };
    return (
      <div aria-hidden className={cn(CARD, "grid grid-cols-7 gap-1")}>
        {Array.from({ length: 21 }, (_, i) => piece(cn("h-[18px] rounded", TINT[marks[i] ?? "plain"], i === 17 && "outline-2 -outline-offset-2 outline-primary")))}
      </div>
    );
  }
  const bars: [keyof typeof TINT, number, number][] = [
    ["yellow", 0, 70],
    ["blue", 20, 45],
    ["blue", 45, 40],
    ["green", 55, 22],
    ["green", 68, 24],
  ];
  return (
    <div aria-hidden className={cn(CARD, "flex flex-col gap-1.5")}>
      {bars.map(([tint, left, width], i) => (
        <div key={i} className="relative h-3.5 rounded bg-subtle">
          {piece(cn("absolute inset-y-0 rounded", TINT[tint]), { left: `${left}%`, width: `${width}%` })}
        </div>
      ))}
    </div>
  );
}
