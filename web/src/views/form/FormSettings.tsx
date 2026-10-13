/** Title, description, submit button, success message, redirect and "submit another" of a form. */
import { useState } from "react";
import { Switch } from "@/components/ui/checkbox";
import { Field, Input, Textarea } from "@/components/ui/input";
import type { FormConfig } from "@/api/types";
import { DEFAULT_SUBMIT_LABEL, DEFAULT_SUCCESS_MESSAGE, MAX_FORM_TEXT, MAX_FORM_TITLE, MAX_REDIRECT_URL, redirectUrlProblem, updateFormSettings, type FormSettingsPatch } from "@/lib/forms/formConfig";

export interface FormSettingsProps {
  form: FormConfig;
  title: string;
  readOnly: boolean;
  onChange: (next: FormConfig) => void;
}

/** The redirect keeps what is typed while it is invalid; only a valid (or empty) address reaches the saved form. */
function RedirectField({ value, readOnly, onValid }: { value: string; readOnly: boolean; onValid: (url: string | null) => void }) {
  const [text, setText] = useState(value);
  // Typing "https://" passes through invalid states; the message waits until the person leaves the box.
  const [touched, setTouched] = useState(false);
  const problem = touched ? redirectUrlProblem(text) : null;
  return (
    <Field label="After submitting, go to" hint="Optional. Visitors of the public form are sent to this address instead of seeing the message." error={problem}>
      {(ctl) => (
        <Input
          {...ctl}
          type="url"
          inputMode="url"
          placeholder="https://example.com/thanks"
          value={text}
          maxLength={MAX_REDIRECT_URL + 1}
          disabled={readOnly}
          onBlur={() => setTouched(true)}
          onChange={(e) => {
            setText(e.target.value);
            if (redirectUrlProblem(e.target.value) === null) onValid(e.target.value.trim() === "" ? null : e.target.value.trim());
          }}
        />
      )}
    </Field>
  );
}

export function FormSettings({ form, title, readOnly, onChange }: FormSettingsProps) {
  const set = (patch: FormSettingsPatch) => onChange(updateFormSettings(form, patch));
  return (
    <section aria-labelledby="form-settings-heading" className="flex flex-col gap-3">
      <h3 id="form-settings-heading" className="text-[0.9375rem]">
        Form
      </h3>
      <Field label="Title" hint="Shown at the top of the form.">
        {(ctl) => <Input {...ctl} value={form.title} placeholder={title} maxLength={MAX_FORM_TITLE} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} />}
      </Field>
      <Field label="Description">
        {(ctl) => <Textarea {...ctl} rows={3} value={form.description} placeholder="Tell people what this form is for" maxLength={MAX_FORM_TEXT} disabled={readOnly} onChange={(e) => set({ description: e.target.value })} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Submit button">
          {(ctl) => <Input {...ctl} value={form.submit_label} placeholder={DEFAULT_SUBMIT_LABEL} maxLength={MAX_FORM_TITLE} disabled={readOnly} onChange={(e) => set({ submit_label: e.target.value })} />}
        </Field>
        <Field label="Success message">
          {(ctl) => <Input {...ctl} value={form.success_message} placeholder={DEFAULT_SUCCESS_MESSAGE} maxLength={MAX_FORM_TEXT} disabled={readOnly} onChange={(e) => set({ success_message: e.target.value })} />}
        </Field>
      </div>
      <RedirectField value={form.redirect_url ?? ""} readOnly={readOnly} onValid={(url) => set({ redirect_url: url })} />
      <Switch checked={form.show_submit_another} disabled={readOnly} onCheckedChange={(on) => set({ show_submit_another: on })} label="Offer “Submit another response” after submitting" />
    </section>
  );
}
