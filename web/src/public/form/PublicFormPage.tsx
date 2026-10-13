/**
 * `/form/:token` (and `/f/:token`): a public form. No account, no app shell, no redirect to the
 * login page. Loads `GET /api/public/forms/{token}`, asks for the password when the link has one
 * (kept in memory), validates before sending, uploads files through the form's own endpoint, and
 * ends with the success message, an optional "Submit another response" and an optional redirect.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { CircleCheck } from "lucide-react";
import { publicApi } from "@/api/sharing";
import type { AttachmentRef, PublicForm } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/layouts";
import { describeSubmitError, safeRedirect } from "@/lib/publicErrors";
import { browserTimeZone } from "@/lib/format";
import { DEFAULT_SUBMIT_LABEL, DEFAULT_SUCCESS_MESSAGE } from "@/lib/forms/formConfig";
import { buildSubmission, emptyInput, hasAnyValue, type FormInput } from "@/lib/forms/publicValues";
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

function initialInputs(form: PublicForm): Record<string, FormInput> {
  return Object.fromEntries(form.fields.map((f) => [f.id, emptyInput(f)]));
}

function FilledForm({ token, password, form }: { token: string; password: string | null; form: PublicForm }) {
  const [inputs, setInputs] = useState<Record<string, FormInput>>(() => initialInputs(form));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const redirect = safeRedirect(form.redirect_url);

  // The visitor sees the message first; a configured redirect follows right after.
  useEffect(() => {
    if (!done || !redirect) return;
    const t = setTimeout(() => window.location.assign(redirect), 1200);
    return () => clearTimeout(t);
  }, [done, redirect]);

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
      await publicApi.submitForm(token, values, password);
      setDone(true);
    } catch (err) {
      setFailure(describeSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <PublicShell>
        <div role="status" className="mx-auto mt-6 flex w-full flex-col items-center gap-3 rounded-lg border border-line bg-surface p-8 text-center shadow-sm">
          <CircleCheck aria-hidden className="size-9 text-success" />
          <h1 className="text-xl">{form.success_message.trim() || DEFAULT_SUCCESS_MESSAGE}</h1>
          {redirect && <p className="text-[0.8125rem] text-muted">Taking you on…</p>}
          {form.show_submit_another && (
            <Button
              variant="primary"
              onClick={() => {
                setInputs(initialInputs(form));
                setErrors({});
                setFailure(null);
                setDone(false);
              }}
            >
              Submit another response
            </Button>
          )}
        </div>
      </PublicShell>
    );
  }

  const anyRequired = form.fields.some((f) => f.required);
  return (
    <PublicShell>
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate aria-label={form.title} className="flex flex-col gap-6 rounded-lg border border-line bg-surface p-5 shadow-sm sm:p-7">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-2xl">{form.title}</h1>
          {form.description.trim() && <p className="whitespace-pre-wrap text-[0.9375rem] text-muted">{form.description}</p>}
          {anyRequired && <p className="text-xs text-muted">Fields marked * are required.</p>}
        </header>
        {form.fields.length === 0 ? (
          <Notice>This form has no questions yet.</Notice>
        ) : (
          <div className="flex flex-col gap-5">
            {form.fields.map((f) => (
              <PublicFieldInput key={f.id} field={f} value={inputs[f.id]} error={errors[f.id]} disabled={submitting} onChange={(v) => set(f.id, v)} upload={upload} />
            ))}
          </div>
        )}
        {failure && <Notice tone="error">{failure}</Notice>}
        {Object.keys(errors).length > 0 && <Notice tone="error">Some answers need attention. Check the fields marked above.</Notice>}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="lg" loading={submitting} disabled={form.fields.length === 0 || uploading > 0}>
            {form.submit_label.trim() || DEFAULT_SUBMIT_LABEL}
          </Button>
          {uploading > 0 && <span className="text-[0.8125rem] text-muted">Waiting for the upload to finish…</span>}
        </div>
      </form>
    </PublicShell>
  );
}
