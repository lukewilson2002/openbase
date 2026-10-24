/**
 * Title, description, submit button, success message, redirect and "submit another" of a form. A redirect
 * address replaces the message and the "submit another" button: people are sent there at once.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Switch } from "@/components/ui/checkbox";
import { Field, Input, Textarea } from "@/components/ui/input";
import type { FormConfig } from "@/api/types";
import { DEFAULT_SUBMIT_LABEL, DEFAULT_SUCCESS_MESSAGE, MAX_FORM_TEXT, MAX_FORM_TITLE, MAX_REDIRECT_URL, RECORD_ID_TOKEN, redirectUrlProblem, updateFormSettings, type FormSettingsPatch } from "@/lib/forms/formConfig";

export interface FormSettingsProps {
  form: FormConfig;
  title: string;
  readOnly: boolean;
  onChange: (next: FormConfig) => void;
}

const inputClass = "h-10 rounded-[10px] px-3 text-[0.875rem]";

/** The redirect keeps what is typed while it is invalid; only a valid (or empty) address reaches the saved form. */
function RedirectField({ value, readOnly, onValid }: { value: string; readOnly: boolean; onValid: (url: string | null) => void }) {
  const [text, setText] = useState(value);
  // Typing "https://" passes through invalid states; the message waits until the person leaves the box.
  const [touched, setTouched] = useState(false);
  const problem = touched ? redirectUrlProblem(text) : null;
  return (
    <Field label="After submitting, go to" hint={`Optional. People are sent to this address right after submitting, in the public form and in Fill in form, instead of seeing the message. ${RECORD_ID_TOKEN} in the address becomes the new record's id.`} error={problem}>
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
          className={inputClass}
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
  // The rarely changed settings wait behind a disclosure, open from the start once one is in use.
  const [more, setMore] = useState(!!form.redirect_url || form.show_submit_another);
  return (
    <section aria-labelledby="form-settings-heading" className="flex flex-col gap-3.5">
      <h3 id="form-settings-heading" className="text-[0.9375rem] font-bold">
        Form
      </h3>
      <Field label="Title">
        {(ctl) => <Input {...ctl} value={form.title} placeholder={title} maxLength={MAX_FORM_TITLE} disabled={readOnly} className={inputClass} onChange={(e) => set({ title: e.target.value })} />}
      </Field>
      <Field label="Description">
        {(ctl) => (
          <Textarea {...ctl} rows={2} value={form.description} placeholder="Tell people what this form is for" maxLength={MAX_FORM_TEXT} disabled={readOnly} className="min-h-[62px] rounded-[10px] px-3 py-2 text-[0.875rem] leading-snug" onChange={(e) => set({ description: e.target.value })} />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Submit button">
          {(ctl) => <Input {...ctl} value={form.submit_label} placeholder={DEFAULT_SUBMIT_LABEL} maxLength={MAX_FORM_TITLE} disabled={readOnly} className={inputClass} onChange={(e) => set({ submit_label: e.target.value })} />}
        </Field>
        <Field label="After submitting" hint={form.redirect_url ? "Not shown while the form goes to another address." : undefined}>
          {(ctl) => <Input {...ctl} value={form.success_message} placeholder={DEFAULT_SUCCESS_MESSAGE} maxLength={MAX_FORM_TEXT} disabled={readOnly} className={inputClass} onChange={(e) => set({ success_message: e.target.value })} />}
        </Field>
      </div>
      <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="-ml-1 flex items-center gap-1 self-start rounded-md px-1 py-0.5 text-[0.8125rem] font-medium text-muted hover:text-fg">
        <ChevronRight aria-hidden className={`size-4 transition-transform ${more ? "rotate-90" : ""}`} /> More options
      </button>
      {more && (
        <div className="flex flex-col gap-3 pl-5">
          <RedirectField value={form.redirect_url ?? ""} readOnly={readOnly} onValid={(url) => set({ redirect_url: url })} />
          <div className="flex flex-col gap-1">
            <Switch checked={form.show_submit_another} disabled={readOnly || !!form.redirect_url} onCheckedChange={(on) => set({ show_submit_another: on })} label="Offer “Submit another response” after submitting" />
            {form.redirect_url && <p className="pl-11 text-xs text-muted">Not offered while the form goes to another address.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
