/** The Color screen of View options: no colors, by a single select property, or by conditions (first matching rule wins). */
import { Plus, X } from "lucide-react";
import type { BaseSchema, Collaborator, RowColor, Table, ViewConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/input";
import { setRowColor } from "./config";
import { FilterBuilder } from "./FilterBuilder";

export interface RowColorEditorProps {
  schema: BaseSchema;
  table: Table;
  config: ViewConfig;
  update: (mutate: (c: ViewConfig) => ViewConfig) => void;
  collaborators: readonly Collaborator[];
}

export function RowColorEditor({ schema, table, config, update, collaborators }: RowColorEditorProps) {
  const rc = config.row_color ?? null;
  const mode = rc?.mode ?? "none";
  const selects = table.fields.filter((f) => f.type === "single_select");
  const setMode = (m: string) => {
    if (m === "none") update((c) => setRowColor(c, null));
    else if (m === "by_select") update((c) => setRowColor(c, { mode: "by_select", field_id: selects[0]?.id ?? "" }));
    else update((c) => setRowColor(c, { mode: "by_conditions", rules: [{ color: "blue", filter: { conjunction: "and", items: [] } }] }));
  };
  const rules = rc?.mode === "by_conditions" ? rc.rules : [];
  const setRules = (next: typeof rules) => update((c) => setRowColor(c, { mode: "by_conditions", rules: next } as RowColor));
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-label font-semibold">Color records</legend>
        {[
          ["none", "No colors"],
          ["by_select", "By a single select property"],
          ["by_conditions", "By conditions"],
        ].map(([v, l]) => (
          <label key={v} className="flex min-h-control-md items-center gap-2 text-ui max-md:min-h-control-touch">
            <input type="radio" name="row-color-mode" checked={mode === v} onChange={() => setMode(v!)} /> {l}
          </label>
        ))}
      </fieldset>
      {rc?.mode === "by_select" &&
        (selects.length === 0 ? (
          <p className="text-label text-muted">This collection has no single select property to color by.</p>
        ) : (
          <Select aria-label="Color by property" value={rc.field_id} onChange={(e) => update((c) => setRowColor(c, { mode: "by_select", field_id: e.target.value }))}>
            {selects.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        ))}
      {rc?.mode === "by_conditions" && (
        <div className="flex flex-col gap-3">
          <p className="text-meta text-muted">The first matching rule decides a record's color.</p>
          {rules.map((r, i) => (
            <div key={i} className="rounded-md border border-line p-2">
              <div className="mb-2 flex items-start justify-between gap-2">
                <ColorSwatchPicker label={`Color for rule ${i + 1}`} value={r.color} onChange={(color) => setRules(rules.map((x, k) => (k === i ? { ...x, color } : x)))} className="flex-1" />
                <IconButton label={`Remove rule ${i + 1}`} size="sm" noTooltip onClick={() => setRules(rules.filter((_, k) => k !== i))}>
                  <X aria-hidden className="size-4" />
                </IconButton>
              </div>
              <FilterBuilder
                label={`Rule ${i + 1} condition`}
                value={r.filter.items.length ? r.filter : null}
                readOnly={false}
                fields={table.fields}
                collaborators={collaborators}
                tables={schema.tables}
                emptyText="Add a condition to color matching records."
                onChange={(f) => setRules(rules.map((x, k) => (k === i ? { ...x, filter: f ?? { conjunction: "and", items: [] } } : x)))}
              />
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setRules([...rules, { color: "green", filter: { conjunction: "and", items: [] } }])}>
            <Plus aria-hidden className="size-4" /> Add color rule
          </Button>
        </div>
      )}
    </div>
  );
}
