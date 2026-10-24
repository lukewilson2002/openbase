/**
 * The form builder: the settings and the field list in a card on the left, a live preview of the
 * form on the right. The preview is inert: nothing typed in it is saved, no select option is created
 * and no file is uploaded. It can switch to what a visitor of the public link gets (the visitors' own
 * inputs, without the fields the public form cannot collect), and its Submit button checks the answers
 * and shows what happens afterwards (message, "Submit another response" or the redirect). On a narrow
 * screen the two take turns behind Edit | Preview.
 *
 * It is read-only for people who may not change the form, and for editors while the form has a public
 * link: the link follows the live form, so the server wants a creator for every change then.
 */
import { useEffect, useMemo, useState } from "react";
import { Eye } from "lucide-react";
import type { Field } from "@/api/types";
import { FormDone } from "@/components/forms/FormDone";
import { Notice } from "@/components/layouts";
import { EditorEnvProvider, type EditValue } from "@/components/record/editors/env";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";
import { resolveForm, type Drafts } from "@/lib/forms/drafts";
import { DEFAULT_SUBMIT_LABEL, DEFAULT_SUCCESS_MESSAGE, liveEntries, previewPublicFields, summarizeForm } from "@/lib/forms/formConfig";
import { buildSubmission, emptyInput, type FormInput } from "@/lib/forms/publicValues";
import { PublicFieldInput } from "@/public/form/PublicFieldInput";
import { SegmentedSwitch } from "../common/SegmentedSwitch";
import type { ViewSetup } from "../common/useViewSetup";
import { FormFieldList } from "./FormFieldList";
import { FormSettings } from "./FormSettings";
import { FormSurface } from "./FormSurface";

export interface FormBuilderProps {
  setup: ViewSetup;
  onChange: (form: ViewSetup["config"]["form"]) => void;
  /** A public link is on and the person is not a creator: the form can be looked at, not changed. */
  linkLocked?: boolean;
  /** Shows a field the form view hides on the public form again. */
  onShowPublic?: (fieldId: string) => void;
}

/** Files are not uploaded from the preview. */
const noUpload = () => Promise.reject(new Error("Files cannot be added in the preview."));

export function FormBuilder({ setup, onChange, linkLocked = false, onShowPublic }: FormBuilderProps) {
  const { table, view, config, cfg, timeZone, people } = setup;
  const form = config.form;
  const readOnly = !cfg.canConfigure || linkLocked;
  const [publicOnly, setPublicOnly] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [publicInputs, setPublicInputs] = useState<Record<string, FormInput>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const summary = summarizeForm(form, table, config);
  const publicFields = useMemo(() => previewPublicFields(form, table, config.hidden_fields), [form, table, config.hidden_fields]);
  // The preview cannot add select options (that would change the field) whoever is looking at it.
  const previewEnv = useMemo(() => ({ ...setup.editorEnv, canCreateOptions: false }), [setup.editorEnv]);

  // What was checked belongs to the form as it was.
  useEffect(() => setErrors({}), [form, publicOnly]);

  const dropError = (id: string) =>
    setErrors((e) => {
      if (!(id in e)) return e;
      const { [id]: _cleared, ...rest } = e;
      return rest;
    });
  const onEdit = (field: Field, edit: EditValue) => {
    setDrafts((d) => ({ ...d, [field.id]: edit }));
    dropError(field.id);
  };

  /** The preview's Submit: the same checks as the real form, and then the "after submitting" screen. */
  const trySubmit = () => {
    const problems = publicOnly
      ? buildSubmission(publicFields, publicInputs, { timeZone }).errors
      : resolveForm(
          liveEntries(form, table).map(({ entry, field }) => ({ field, required: entry.required })),
          drafts,
          { timeZone, users: people },
        ).errors;
    setErrors(problems);
    if (Object.keys(problems).length === 0) setSent(true);
  };

  const again = () => {
    setDrafts({});
    setPublicInputs({});
    setErrors({});
    setResetKey((k) => k + 1);
    setSent(false);
  };

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
          {readOnly && (
            <Notice>
              {linkLocked
                ? "This form has a public link, which follows the form as it is now. Only a creator can change it."
                : view.locked
                  ? "This view is locked. Only a creator can change the form."
                  : "You do not have permission to change this form."}
            </Notice>
          )}
          <FormSettings form={form} title={view.name} readOnly={readOnly} onChange={onChange} />
          <div aria-hidden className="my-0.5 h-px bg-[color-mix(in_srgb,var(--line)_60%,var(--surface))]" />
          <FormFieldList form={form} table={table} hiddenFields={config.hidden_fields} readOnly={readOnly} onChange={onChange} onShowPublic={onShowPublic} />
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
        {sent ? (
          <div className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-2">
            {form.redirect_url ? (
              <FormDone className="rounded-[14px] shadow-[0_10px_28px_rgb(15_20_30/0.06)]" message="Visitors are sent to another address" note={<span className="break-all">{form.redirect_url}</span>} />
            ) : (
              <FormDone className="rounded-[14px] shadow-[0_10px_28px_rgb(15_20_30/0.06)]" message={form.success_message.trim() || DEFAULT_SUCCESS_MESSAGE} onAnother={form.show_submit_another ? again : undefined} />
            )}
            <Button variant="ghost" onClick={() => setSent(false)}>
              Back to the form
            </Button>
          </div>
        ) : (
          <EditorEnvProvider value={previewEnv}>
            <FormSurface
              title={view.name}
              label="Form preview"
              form={form}
              table={table}
              hiddenFields={config.hidden_fields}
              publicOnly={publicOnly}
              drafts={drafts}
              onEdit={onEdit}
              errors={errors}
              resetKey={resetKey}
              inert
              onSubmit={trySubmit}
              renderField={
                publicOnly
                  ? (_entry, field) => {
                      const pf = publicFields.find((f) => f.id === field.id);
                      if (!pf) return null;
                      return (
                        <PublicFieldInput
                          field={pf}
                          value={publicInputs[pf.id] ?? emptyInput(pf)}
                          error={errors[pf.id]}
                          onChange={(v) => {
                            setPublicInputs((cur) => ({ ...cur, [pf.id]: v }));
                            dropError(pf.id);
                          }}
                          upload={noUpload}
                        />
                      );
                    }
                  : undefined
              }
              className="max-w-[560px]"
              footer={
                <div className="flex flex-col gap-3">
                  {Object.keys(errors).length > 0 && <Notice tone="error">Some answers need attention. Check the fields marked above.</Notice>}
                  <div>
                    <Button variant="primary" size="lg" className="h-11 rounded-[10px] px-[22px] font-[650]" title="Try the form: nothing is sent or saved" onClick={trySubmit}>
                      {form.submit_label.trim() || DEFAULT_SUBMIT_LABEL}
                    </Button>
                  </div>
                </div>
              }
            />
          </EditorEnvProvider>
        )}
      </section>
    </div>
  );
}
