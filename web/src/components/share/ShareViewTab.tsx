/**
 * "Share a view", the second part of the Share dialog (APP-8): pick a view, read what a link to it shows,
 * then manage its links (`ShareLinks`: copy, switch off, password, delete).
 */
import { useState } from "react";
import { Eye } from "lucide-react";
import type { View } from "@/api/types";
import { Field, Select } from "@/components/ui/input";
import { ShareLinks } from "./ShareLinks";
import { shareKindOf } from "./shareView";

export function ShareViewTab({
  views,
  initialViewId,
  label = (v) => v.name,
  emptyText = "This collection has no views that can be shared. Personal views stay private.",
}: {
  views: readonly View[];
  initialViewId?: string | null;
  /** How a view is named in the picker (from the workspace: "Chores › All chores"). */
  label?: (view: View) => string;
  emptyText?: string;
}) {
  const shareable = views.filter((v) => !v.personal);
  const [viewId, setViewId] = useState(() => (shareable.some((v) => v.id === initialViewId) ? initialViewId! : (shareable[0]?.id ?? "")));
  const view = shareable.find((v) => v.id === viewId);

  if (!view) return <p className="text-ui text-muted">{emptyText}</p>;
  const kind = shareKindOf(view);
  return (
    <div className="flex flex-col gap-4">
      <Field label="View" className="[&>label]:font-semibold">
        {(ctl) => (
          <Select {...ctl} value={viewId} onChange={(e) => setViewId(e.target.value)} className="h-control-touch text-read-phone">
            {shareable.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex gap-2.5 rounded-md bg-primary-soft px-3.5 py-3 text-ui text-fg">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-mark" />
        <p>
          {kind === "form"
            ? "Anyone with the link can fill in this form and add a record. They never see the records already in the collection, and can't open the rest of the folder."
            : `Anyone with the link sees only what this view shows: its records and properties, now and as they change later. They can't edit anything or open the rest of the folder.${hiddenNote(view)}`}
        </p>
      </div>
      {/* Keyed by view: a half-typed password must not carry over to another view's link. */}
      <ShareLinks key={view.id} view={view} kind={kind} />
    </div>
  );
}

/**
 * Says the hidden fields stay private, the question people ask before sharing a sheet with a
 * salary column in it. The server drops hidden fields from shared views, so this is a promise.
 */
function hiddenNote(view: View): string {
  const n = view.config.hidden_fields.length;
  return n > 0 ? ` The ${n} hidden property${n === 1 ? "" : "s"} never leave${n === 1 ? "s" : ""} the server.` : "";
}

