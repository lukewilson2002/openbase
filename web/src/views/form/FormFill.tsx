/**
 * "Fill in form" for signed-in editors: the form as configured (every field, including links and
 * users, which the public form cannot collect), submitting a record through the normal records
 * API (`POST /api/tables/{id}/records`, typecast on), so history, automations and live updates
 * behave exactly as for any other new record.
 */
import { EntityLabel } from "@/components/icons/EntityIcon";
import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { errorMessage } from "@/api/client";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field } from "@/api/types";
import { Notice } from "@/components/layouts";
import type { EditValue } from "@/components/record/editors/env";
import { Button } from "@/components/ui/button";
import { resolveForm, type Drafts } from "@/lib/forms/drafts";
import { DEFAULT_SUBMIT_LABEL, DEFAULT_SUCCESS_MESSAGE, liveEntries } from "@/lib/forms/formConfig";
import type { ViewSetup } from "../common/useViewSetup";
import { FormSurface } from "./FormSurface";

export function FormFill({ setup }: { setup: ViewSetup }) {
  const { table, view, config, people, timeZone } = setup;
  const form = config.form;
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Drafts>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => liveEntries(form, table), [form, table]);

  const onEdit = (field: Field, edit: EditValue) => {
    setDrafts((d) => ({ ...d, [field.id]: edit }));
    setErrors((e) => {
      if (!(field.id in e)) return e;
      const { [field.id]: _cleared, ...rest } = e;
      return rest;
    });
  };

  const submit = async () => {
    setFailure(null);
    const resolved = resolveForm(
      entries.map(({ entry, field }) => ({ field, required: entry.required })),
      drafts,
      { timeZone, users: people },
    );
    setErrors(resolved.errors);
    if (Object.keys(resolved.errors).length > 0) {
      top.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      return;
    }
    if (Object.keys(resolved.values).length === 0) {
      setFailure("Fill in at least one field first.");
      return;
    }
    setSubmitting(true);
    try {
      await recordsApi.create(table.id, { records: [{ values: resolved.values as never }], typecast: true });
      // A link field changes the linked table's records too.
      void qc.invalidateQueries({ queryKey: entries.some((e) => e.field.type === "link") ? ["records"] : recordKeys.table(table.id) });
      setDone(true);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-lg border border-line bg-surface p-8 text-center shadow-sm" role="status">
        <CircleCheck aria-hidden className="size-8 text-success" />
        <h2 className="text-xl">{form.success_message.trim() || DEFAULT_SUCCESS_MESSAGE}</h2>
        <p className="inline-flex items-center gap-1.5 text-[0.8125rem] text-muted">
          The record was added to <EntityLabel icon={table.icon}>{table.name}</EntityLabel>.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setDrafts({});
            setErrors({});
            setFailure(null);
            setResetKey((k) => k + 1);
            setDone(false);
          }}
        >
          Submit another response
        </Button>
      </div>
    );
  }

  return (
    <div ref={top}>
      <FormSurface
        title={view.name}
        form={form}
        table={table}
        hiddenFields={config.hidden_fields}
        drafts={drafts}
        onEdit={onEdit}
        errors={errors}
        resetKey={resetKey}
        banner={form.redirect_url ? <Notice>Visitors of the public form are sent to {form.redirect_url} after submitting; here you stay on this page.</Notice> : undefined}
        footer={
          <div className="flex flex-col gap-3">
            {failure && <Notice tone="error">{failure}</Notice>}
            {Object.keys(errors).length > 0 && <Notice tone="error">Some answers need attention. Check the fields marked above.</Notice>}
            <div>
              <Button variant="primary" size="lg" loading={submitting} disabled={entries.length === 0} onClick={() => void submit()}>
                {form.submit_label.trim() || DEFAULT_SUBMIT_LABEL}
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
