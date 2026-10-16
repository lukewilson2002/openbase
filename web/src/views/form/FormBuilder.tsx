/**
 * The form builder: the settings and the field list in a card on the left, a live preview of the
 * form (the same editors people fill in, with nothing saved) on the right. The preview can switch
 * to what a visitor of the public link gets, which leaves out the fields the public form cannot
 * collect. On a narrow screen the two take turns behind Edit | Preview.
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
import { SegmentedSwitch } from "../common/SegmentedSwitch";
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
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-3 md:p-4 lg:flex-row">
      <SegmentedSwitch
        label="Builder panes"
        className="self-start lg:hidden"
        value={pane}
        options={[
          { value: "edit", label: "Edit" },
          { value: "preview", label: "Preview" },
        ]}
        onChange={setPane}
      />

      <section
        aria-label="Form settings"
        className={cn("min-h-0 flex-1 overflow-y-auto rounded-xl border border-line bg-surface px-5 py-[18px] lg:w-[440px] lg:flex-none", pane === "preview" && "max-lg:hidden")}
      >
        <div className="flex flex-col gap-3.5">
          {readOnly && <Notice>{view.locked ? "This view is locked. Only a creator can change the form." : "You do not have permission to change this form."}</Notice>}
          <FormSettings form={form} title={view.name} readOnly={readOnly} onChange={onChange} />
          <div aria-hidden className="my-0.5 h-px bg-[color-mix(in_srgb,var(--line)_60%,var(--surface))]" />
          <FormFieldList form={form} table={table} hiddenFields={config.hidden_fields} readOnly={readOnly} onChange={onChange} />
        </div>
      </section>

      <section aria-label="Live preview" className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto", pane === "edit" && "max-lg:hidden")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
          <p className="flex items-center gap-2 text-[0.875rem]">
            <Eye aria-hidden className="size-4 text-muted" />
            <strong className="font-semibold">Live preview</strong>
            <span className="text-muted">· Nothing you type here is saved.</span>
          </p>
          <Switch className="ml-auto" checked={publicOnly} onCheckedChange={setPublicOnly} label="Public form only" />
        </div>
        {summary.excluded.length > 0 && (
          <div className="mx-auto w-full max-w-[560px]">
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
          className="max-w-[560px]"
          footer={
            <div>
              {/* aria-disabled, not disabled: the preview should look like the real form, not a faded one. */}
              <Button variant="primary" size="lg" className="h-11 cursor-default rounded-[10px] px-[22px] font-[650]" aria-disabled title="This is a preview: nothing is submitted">
                {form.submit_label.trim() || DEFAULT_SUBMIT_LABEL}
              </Button>
            </div>
          }
        />
      </section>
    </div>
  );
}
