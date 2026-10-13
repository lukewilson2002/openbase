/** "New automation": a name and the kind of trigger. The rest is filled in on the editor page. */
import { useState, type FormEvent } from "react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import type { Automation } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { useAutomationEnv } from "./context";
import { TRIGGER_HINTS, TRIGGER_LABELS, TRIGGER_TYPES, newTrigger, triggerUnavailableReason, type TriggerType } from "./model";

export interface CreateAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseId: string;
  onCreated: (automation: Automation) => void;
}

export function CreateAutomationDialog({ open, onOpenChange, baseId, onCreated }: CreateAutomationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New automation" description="Pick what starts it. You add the actions next; it stays off until you turn it on." size="sm">
      <CreateForm baseId={baseId} onCancel={() => onOpenChange(false)} onCreated={onCreated} />
    </Dialog>
  );
}

function CreateForm({ baseId, onCancel, onCreated }: { baseId: string; onCancel: () => void; onCreated: (a: Automation) => void }) {
  const { schema, timeZone } = useAutomationEnv();
  const firstAvailable = TRIGGER_TYPES.find((t) => !triggerUnavailableReason(t, schema)) ?? "webhook";
  const [name, setName] = useState("");
  const [type, setType] = useState<TriggerType>(firstAvailable);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trigger = newTrigger(type, schema, timeZone);
    if (!name.trim() || !trigger) return;
    setPending(true);
    setError(null);
    try {
      const created = await api.automations.create(baseId, { name: name.trim(), trigger, actions: [] });
      onCreated(created);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Name">{(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus required placeholder="e.g. Copy new tasks to the archive" />}</Field>
      <Field label="When this happens" hint={TRIGGER_HINTS[type]}>
        {(ctl) => (
          <Select {...ctl} value={type} onChange={(e) => setType(e.target.value as TriggerType)}>
            {TRIGGER_TYPES.map((t) => {
              const why = triggerUnavailableReason(t, schema);
              return (
                <option key={t} value={t} disabled={!!why}>
                  {TRIGGER_LABELS[t]}
                  {why ? ` (${why.toLowerCase()})` : ""}
                </option>
              );
            })}
          </Select>
        )}
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
          Create automation
        </Button>
      </div>
    </form>
  );
}
