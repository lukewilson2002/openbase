/**
 * `/form/:token` (and `/f/:token`): a public form. No account, no app shell, no redirect to the
 * login page. Loads `GET /api/public/forms/{token}`, asks for the password when the link has one
 * (kept in memory), validates before sending, uploads files through the form's own endpoint, and
 * ends with the success message and an optional "Submit another response", or, when the form has a
 * redirect address, goes straight there (the address may carry the new record's id).
 */
import { EntityLabel } from "@/components/icons/EntityIcon";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useParams } from "react-router";
import { publicApi } from "@/api/sharing";
import type { AttachmentRef, PublicForm } from "@/api/types";
import { FormDone } from "@/components/forms/FormDone";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/layouts";
import { describeSubmitError } from "@/lib/publicErrors";
import { browserTimeZone } from "@/lib/format";
import { DEFAULT_SUBMIT_LABEL, DEFAULT_SUCCESS_MESSAGE, redirectAfterSubmit } from "@/lib/forms/formConfig";
import { readPrefill, type Prefill } from "@/lib/forms/prefill";
import { buildSubmission, hasAnyValue, initialInput, shownFields, type FormInput } from "@/lib/forms/publicValues";
import { PasswordPrompt, PublicLoading, PublicProblemScreen, PublicShell } from "../PublicShell";
import { usePublicLoad } from "../usePublicLoad";
import { PublicFieldInput } from "./PublicFieldInput";

export default function PublicFormPage() {
  const { token = "" } = useParams();
  const load = usePublicLoad<PublicForm>(token, "form", (t, password, signal) => publicApi.form(t, password, signal));
  const { state } = load;
  if (state.status === "loading") return <PublicLoading />;
  if (state.status === "password") return <PasswordPrompt what="form" invalid={state.invalid} checking={load.checking} onSubmit={load.submitPassword} />;
  if (state.status === "problem") return <PublicProblemScreen problem={state.problem} onRetry={load.retry} />;
  return <FilledForm token={token} password={load.password} form={state.data} />;
}

/** What each input starts with: the address's prefill, else the field's default, else nothing. */
function initialInputs(form: PublicForm, prefill: Prefill): Record<string, FormInput> {
  return Object.fromEntries(form.fields.filter((f) => !f.block).map((f) => [f.id, prefill.values[f.id] ?? initialInput(f)]));
}

function FilledForm({ token, password, form }: { token: string; password: string | null; form: PublicForm }) {
  const { search } = useLocation();
  // The address can start fields off with a value and take some off the page (see lib/forms/prefill).
  const prefill = useMemo(() => readPrefill(form.fields, search), [form.fields, search]);
  const [inputs, setInputs] = useState<Record<string, FormInput>>(() => initialInputs(form, prefill));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  // Set once the answers were sent: the id of the new record (it can be part of the redirect address).
  const [done, setDone] = useState<{ recordId: string | null } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const redirect = done ? redirectAfterSubmit(form.redirect_url, done.recordId) : null;

  // A form with a redirect address sends people there at once, in place of the message.
  useEffect(() => {
    if (redirect) window.location.assign(redirect);
  }, [redirect]);

  const set = useCallback((id: string, value: FormInput) => {
    setInputs((cur) => ({ ...cur, [id]: value }));
    setErrors((cur) => {
      if (!(id in cur)) return cur;
      const { [id]: _gone, ...rest } = cur;
      return rest;
    });
  }, []);

  const upload = useCallback(
    async (file: File): Promise<AttachmentRef> => {
      setUploading((n) => n + 1);
      try {
        return await publicApi.uploadFormFile(token, file, password);
      } finally {
        setUploading((n) => n - 1);
      }
    },
    [token, password],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    const { values, errors: problems } = buildSubmission(form.fields, inputs, { timeZone: browserTimeZone() });
    setErrors(problems);
    const firstBad = form.fields.find((f) => problems[f.id]);
    if (firstBad) {
      const block = [...(formRef.current?.querySelectorAll<HTMLElement>("[data-field-id]") ?? [])].find((el) => el.dataset["fieldId"] === firstBad.id);
      block?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
      return;
    }
    if (!hasAnyValue(values)) {
      setFailure("Fill in at least one answer before sending.");
      return;
    }
    setSubmitting(true);
    try {
      const sent = await publicApi.submitForm(token, values, password);
      setDone({ recordId: sent?.record_id ?? null });
    } catch (err) {
      setFailure(describeSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    const another = () => {
      setInputs(initialInputs(form, prefill));
      setErrors({});
      setFailure(null);
      setDone(null);
    };
    return (
      <PublicShell>
        {redirect ? (
          <FormDone level={1} className="mt-6 rounded-lg shadow-sm" message="Taking you on…" note={<a href={redirect} className="text-primary-text underline">Continue</a>} />
        ) : (
          <FormDone level={1} className="mt-6 rounded-lg shadow-sm" message={form.success_message.trim() || DEFAULT_SUCCESS_MESSAGE} onAnother={form.show_submit_another ? another : undefined} />
        )}
      </PublicShell>
    );
  }

  // What the visitor sees: the entries whose show-if holds for the answers above them, without the fields the address hides.
  const timeZone = browserTimeZone();
  const shown = shownFields(form.fields, inputs, { timeZone });
  const visible = form.fields.filter((f) => shown.has(f.id) && !prefill.hidden.has(f.id));
  const questions = form.fields.filter((f) => !f.block);
  const anyRequired = visible.some((f) => !f.block && f.required);
  return (
    <PublicShell>
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate aria-label={form.title} className="flex flex-col gap-6 rounded-lg border border-line bg-surface p-5 shadow-sm sm:p-7">
        <header className="flex flex-col gap-1.5">
          <p className="inline-flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <EntityLabel icon={form.base_icon}>{form.base_name}</EntityLabel> <span aria-hidden>/</span> <EntityLabel icon={form.table_icon}>{form.table_name}</EntityLabel>
          </p>
          <h1 className="text-2xl">{form.title}</h1>
          {form.description.trim() && <p className="whitespace-pre-wrap text-[0.9375rem] text-muted">{form.description}</p>}
          {anyRequired && <p className="text-xs text-muted">Fields marked * are required.</p>}
        </header>
        {questions.length === 0 ? (
          <Notice>This form has no questions yet.</Notice>
        ) : (
          <div className="flex flex-col gap-5">
            {visible.map((f) =>
              f.block ? <PublicFormBlock key={f.id} field={f} /> : <PublicFieldInput key={f.id} field={f} value={inputs[f.id]} error={errors[f.id]} disabled={submitting} onChange={(v) => set(f.id, v)} upload={upload} />,
            )}
          </div>
        )}
        {failure && <Notice tone="error">{failure}</Notice>}
        {Object.keys(errors).length > 0 && <Notice tone="error">Some answers need attention. Check the fields marked above.</Notice>}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="lg" loading={submitting} disabled={questions.length === 0 || uploading > 0}>
            {form.submit_label.trim() || DEFAULT_SUBMIT_LABEL}
          </Button>
          {uploading > 0 && <span className="text-[0.8125rem] text-muted">Waiting for the upload to finish…</span>}
        </div>
      </form>
    </PublicShell>
  );
}

/** A heading or a paragraph between the questions. */
export function PublicFormBlock({ field }: { field: PublicForm["fields"][number] }) {
  if (field.block === "heading") return <h2 className="mt-2 border-b border-line pb-1.5 text-lg font-semibold">{field.label}</h2>;
  return <p className="whitespace-pre-wrap text-[0.9375rem] leading-normal text-muted">{field.help}</p>;
}
