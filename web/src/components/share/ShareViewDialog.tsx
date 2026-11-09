/**
 * "Share view" for creators and owners, opened from the form builder: what is public, then the share
 * links of one view (`ShareLinks`). Everywhere else the same links live in the Share dialog.
 */
import type { ShareKind, Table, View } from "@/api/types";
import { Dialog } from "@/components/ui/dialog";
import { liveEntries, publicStatus } from "@/lib/forms/formConfig";
import { ShareLinks } from "./ShareLinks";
import { MAX_SHARES_PER_VIEW, canShareView, shareKindOf } from "./shareView";

export { MAX_SHARES_PER_VIEW, canShareView, shareKindOf };

export interface ShareViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: View;
  table: Pick<Table, "fields" | "primary_field_id">;
}

export function ShareViewDialog({ open, onOpenChange, view, table }: ShareViewDialogProps) {
  const kind = shareKindOf(view);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Share ${view.name}`}
      description={kind === "form" ? "Let anyone fill in this form, without an account." : "Let anyone look at this view, without an account."}
    >
      {open && (
        <div className="flex flex-col gap-5">
          <WhatIsPublic view={view} table={table} kind={kind} />
          <ShareLinks view={view} kind={kind} />
        </div>
      )}
    </Dialog>
  );
}

function WhatIsPublic({ view, table, kind }: { view: View; table: ShareViewDialogProps["table"]; kind: ShareKind }) {
  if (kind === "form") {
    const entries = liveEntries(view.config.form, table);
    const shown = entries.filter((e) => publicStatus(e.field, view.config.hidden_fields).public);
    const left = entries.length - shown.length;
    const notified = view.config.form.notify_user_ids.length;
    return (
      <div className="flex flex-col gap-1 rounded-md bg-subtle px-3 py-2 text-label">
        <p>
          <strong>What visitors can do:</strong> fill in and submit this form, once per submission. They never see any record, existing or new.
        </p>
        <p>
          <strong>What the form asks:</strong> {shown.length} field{shown.length === 1 ? "" : "s"}
          {shown.length > 0 && <>: {shown.map((e) => e.entry.label?.trim() || e.field.name).join(", ")}</>}.
          {left > 0 && ` ${left} more (links and users) are not collected publicly.`}
        </p>
        {shown.length === 0 && <p className="text-danger">The form has no properties visitors can fill in. Add some in the builder first.</p>}
        <p>
          <strong>Responses:</strong>{" "}
          {notified === 0
            ? "nobody is told when one comes in. Turn on “Notify me of new responses” in the form builder."
            : `${notified} ${notified === 1 ? "person is" : "people are"} notified of each one (in the app, and by email if this server can send mail).`}
        </p>
        <p>
          <strong>Prefill:</strong> add <code>?prefill_Field name=value</code> to a link to start a field with that value, and <code>&amp;hide_Field name=true</code> to take it off the page.
        </p>
      </div>
    );
  }
  const hiddenCount = view.config.hidden_fields.filter((id) => id !== table.primary_field_id && table.fields.some((f) => f.id === id)).length;
  const shownCount = table.fields.length - hiddenCount;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-subtle px-3 py-2 text-label">
      <p>
        <strong>What is public:</strong> the records this view shows (its filter and sort apply), read-only, with the {shownCount} visible field{shownCount === 1 ? "" : "s"}.
        {hiddenCount > 0 ? ` The ${hiddenCount} hidden property${hiddenCount === 1 ? "" : "s"} never leave${hiddenCount === 1 ? "s" : ""} the server.` : " Hide a property in this view to keep it private."}
      </p>
      <p>
        <strong>What is not:</strong> e-mail addresses and user ids, who edited a record, comments and history. People are shown by name only. Changes you make to the view or the records show up for visitors straight away.
      </p>
    </div>
  );
}
