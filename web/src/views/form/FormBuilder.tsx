/**
 * The form builder: settings and the field list on one side, a live preview of the form (the same
 * editors people fill in, with nothing saved) on the other. The preview can switch to what a
 * visitor of the public link gets, which leaves out the fields the public form cannot collect.
 */
import { useState } from "react";
import { Eye } from "lucide-react";
import type { Field } from "@/api/types";
import { Notice } from "@/components/layouts";
import type { EditValue } from "@/components/record/editors/env";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";
import type { Drafts } from "@/lib/forms/drafts";
import { DEFAULT_SUBMIT_LABEL, summarizeForm } from "@/lib/forms/formConfig";
import type { ViewSetup } from "../common/useViewSetup";
import { FormFieldList } from "./FormFieldList";
import { FormSettings } from "./FormSettings";
import { FormSurface } from "./FormSurface";

export function FormBuilder({ setup, onChange }: { setup: ViewSetup; onChange: (form: ViewSetup["config"]["form"]) => void }) {
  const { table, view, config, cfg } = setup;
  const form = config.form;
  const readOnly = !cfg.canConfigure;
  const [publicOnly, setPublicOnly] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const summary = summarizeForm(form, table, config);

  const onEdit = (field: Field, edit: EditValue) => setDrafts((d) => ({ ...d, [field.id]: edit }));

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div role="tablist" aria-label="Builder panes" className="flex gap-1 border-b border-line px-3 py-1.5 lg:hidden">
        {(["edit", "preview"] as const).map((p) => (
          <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={cn("rounded px-3 py-1 text-[0.8125rem] font-medium", pane === p ? "bg-primary-soft text-primary" : "text-muted hover:bg-hover")}>
            {p === "edit" ? "Edit" : "Preview"}
          </button>
        ))}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto p-4 lg:max-w-[34rem] lg:flex-none lg:basis-[34rem] lg:border-r lg:border-line", pane === "preview" && "hidden lg:block")}>
        <div className="flex flex-col gap-6">
          {readOnly && <Notice>{view.locked ? "This view is locked. Only a creator can change the form." : "You do not have permission to change this form."}</Notice>}
          <FormSettings form={form} title={view.name} readOnly={readOnly} onChange={onChange} />
          <FormFieldList form={form} table={table} hiddenFields={config.hidden_fields} readOnly={readOnly} onChange={onChange} />
        </div>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto bg-subtle p-4", pane === "edit" && "hidden lg:block")}>
        <div className="mx-auto mb-3 flex max-w-xl flex-wrap items-center justify-between gap-2">
          <p className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium">
            <Eye aria-hidden className="size-4" /> Live preview
          </p>
          <Switch checked={publicOnly} onCheckedChange={setPublicOnly} label="Show only what the public form asks" />
        </div>
        {summary.excluded.length > 0 && (
          <div className="mx-auto mb-3 max-w-xl">
            <Notice tone="warning">
              <strong>{summary.publicCount === 0 ? "No field" : `${summary.publicCount} of ${summary.total} fields`}</strong> will appear on the public form.{" "}
              {summary.excluded.map((e) => `${e.field.name} (${e.status.reason === "hidden" ? "hidden in this view" : `${e.status.reason} field`})`).join(", ")} stay{summary.excluded.length === 1 ? "s" : ""} off it: public forms never collect link or user fields.
            </Notice>
          </div>
        )}
        <FormSurface
          title={view.name}
          label="Form preview"
          form={form}
          table={table}
          hiddenFields={config.hidden_fields}
          publicOnly={publicOnly}
          drafts={drafts}
          onEdit={onEdit}
          errors={{}}
          resetKey={0}
          footer={
            <div className="flex items-center gap-3">
              <Button variant="primary" size="lg" disabled title="This is a preview: nothing is submitted">
                {form.submit_label.trim() || DEFAULT_SUBMIT_LABEL}
              </Button>
              <span className="text-xs text-muted">Preview only. Nothing you enter here is saved.</span>
            </div>
          }
        />
      </div>
    </div>
  );
}
