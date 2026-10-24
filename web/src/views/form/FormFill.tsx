/**
 * "Fill in form" for signed-in editors: the form as configured (every field, including links and
 * users, which the public form cannot collect), submitting a record through the normal records
 * API (`POST /api/tables/{id}/records`, typecast on), so history, automations and live updates
 * behave exactly as for any other new record. Sending works from the keyboard (Enter in a one-line
 * input, Ctrl or Cmd+Enter anywhere), a refusal puts the cursor in the first field that needs
 * attention, and what happens afterwards (message, redirect, submit another) is what the public
 * page does.
 */
import { EntityLabel } from "@/components/icons/EntityIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field } from "@/api/types";
import { FormDone } from "@/components/forms/FormDone";
import { Notice } from "@/components/layouts";
import type { EditValue } from "@/components/record/editors/env";
import { Button } from "@/components/ui/button";
import { defaultDrafts, resolveForm, shownItems, type Drafts } from "@/lib/forms/drafts";
import { DEFAULT_SUBMIT_LABEL, DEFAULT_SUCCESS_MESSAGE, fieldDefault, liveEntries, liveItems, redirectAfterSubmit } from "@/lib/forms/formConfig";
import type { ViewSetup } from "../common/useViewSetup";
import { FormSurface } from "./FormSurface";

export function FormFill({ setup }: { setup: ViewSetup }) {
  const { table, view, config, people, timeZone } = setup;
  const form = config.form;
  const qc = useQueryClient();
  const items = useMemo(() => liveItems(form, table), [form, table]);
  // Fields with a default start with it, as they do on the public form.
  const [drafts, setDrafts] = useState<Drafts>(() => defaultDrafts(items));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set once the record was added: its id (it can be part of the redirect address).
  const [done, setDone] = useState<{ recordId: string | null } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => liveEntries(form, table), [form, table]);
  const shown = useMemo(() => shownItems(items, drafts, { timeZone, users: people }), [items, drafts, timeZone, people]);
  const redirect = done ? redirectAfterSubmit(form.redirect_url, done.recordId) : null;

  // A form with a redirect address sends people there at once, in place of the message.
  useEffect(() => {
    if (redirect) window.location.assign(redirect);
  }, [redirect]);

  const onEdit = (field: Field, edit: EditValue) => {
    setDrafts((d) => ({ ...d, [field.id]: edit }));
    setErrors((e) => {
      if (!(field.id in e)) return e;
      const { [field.id]: _cleared, ...rest } = e;
      return rest;
    });
  };

  /** Puts the cursor in the field (the first one that needs attention) and brings it into view. */
  const focusField = (id: string) => {
    const block = [...(top.current?.querySelectorAll<HTMLElement>("[data-field-id]") ?? [])].find((el) => el.dataset["fieldId"] === id);
    block?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    block?.querySelector<HTMLElement>("input, textarea, select, button, [contenteditable=true]")?.focus({ preventScroll: true });
  };

  const submit = async () => {
    if (submitting) return;
    setFailure(null);
    const resolved = resolveForm(
      entries.map(({ entry, field }) => ({ field, required: entry.required })),
      drafts,
      { timeZone, users: people },
      shown,
    );
    setErrors(resolved.errors);
    const firstBad = entries.find(({ field }) => resolved.errors[field.id]);
    if (firstBad) {
      focusField(firstBad.field.id);
      return;
    }
    if (Object.keys(resolved.values).length === 0) {
      setFailure("Fill in at least one field first.");
      return;
    }
    // A field with a default that was cleared, or is hidden by a show-if, stays empty instead of getting the default.
    const values: Record<string, unknown> = { ...resolved.values };
    for (const { field } of entries) if (!(field.id in values) && fieldDefault(field) !== null) values[field.id] = null;
    setSubmitting(true);
    try {
      const created = await recordsApi.create(table.id, { records: [{ values: values as never }], typecast: true });
      // A link field changes the linked table's records too.
      void qc.invalidateQueries({ queryKey: entries.some((e) => e.field.type === "link") ? ["records"] : recordKeys.table(table.id) });
      setDone({ recordId: created?.records?.[0]?.id ?? null });
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    const another = () => {
      setDrafts(defaultDrafts(items));
      setErrors({});
      setFailure(null);
      setResetKey((k) => k + 1);
      setDone(null);
    };
    const shape = "max-w-[600px] rounded-[14px] shadow-[0_10px_28px_rgb(15_20_30/0.06)]";
    return redirect ? (
      <FormDone className={shape} message="Taking you on…" note={<a href={redirect} className="text-primary-text underline">Continue</a>} />
    ) : (
      <FormDone
        className={shape}
        message={form.success_message.trim() || DEFAULT_SUCCESS_MESSAGE}
        note={
          <span className="inline-flex items-center gap-1.5">
            The record was added to <EntityLabel icon={table.icon}>{table.name}</EntityLabel>.
          </span>
        }
        onAnother={form.show_submit_another ? another : undefined}
      />
    );
  }

  return (
    <div ref={top}>
      <FormSurface
        title={view.name}
        form={form}
        table={table}
        hiddenFields={config.hidden_fields}
        visible={shown}
        drafts={drafts}
        onEdit={onEdit}
        errors={errors}
        resetKey={resetKey}
        onSubmit={() => void submit()}
        footer={
          <div className="flex flex-col gap-3">
            {failure && <Notice tone="error">{failure}</Notice>}
            {Object.keys(errors).length > 0 && <Notice tone="error">Some answers need attention. Check the fields marked above.</Notice>}
            <div>
              <Button variant="primary" size="lg" className="h-11 rounded-[10px] px-[22px] font-[650]" loading={submitting} disabled={entries.length === 0} onClick={() => void submit()}>
                {form.submit_label.trim() || DEFAULT_SUBMIT_LABEL}
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
