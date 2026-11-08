/**
 * Save as view (COL-5): names the draft and says who gets the new view, Only me or Everyone. Everyone is
 * for creators, as for any shared view; the name starts as the changes in plain words, so Enter is enough.
 */
import { useId, useState, type FormEvent } from "react";
import { errorMessage } from "@/api/client";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";

export interface SaveAsViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The suggested name. */
  initialName: string;
  /** Whether Everyone is offered (creators and up). */
  canShareWithEveryone: boolean;
  /** Makes the view; closes the dialog when it resolves and shows the error when it throws. */
  onSave: (input: { name: string; personal: boolean }) => Promise<unknown>;
}

export function SaveAsViewDialog({ open, onOpenChange, initialName, canShareWithEveryone, onSave }: SaveAsViewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Save as view" description="The changes become a view of their own. This view stays as it is." size="sm">
      <SaveAsViewForm initialName={initialName} canShareWithEveryone={canShareWithEveryone} onSave={onSave} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function SaveAsViewForm({ initialName, canShareWithEveryone, onSave, onDone }: Pick<SaveAsViewDialogProps, "initialName" | "canShareWithEveryone" | "onSave"> & { onDone: () => void }) {
  const [name, setName] = useState(initialName);
  const [audience, setAudience] = useState<"me" | "everyone">("me");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      await onSave({ name: trimmed, personal: audience !== "everyone" });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  const option = (value: "me" | "everyone", label: string, disabled = false, hint?: string) => (
    <label className="flex min-h-control-touch items-start gap-2.5 py-1.5 text-ui md:min-h-0">
      <input type="radio" name={group} value={value} checked={audience === value} disabled={disabled || pending} onChange={() => setAudience(value)} className="mt-1 size-4 accent-primary" />
      <span className="flex flex-col">
        <span className={disabled ? "text-muted" : undefined}>{label}</span>
        {hint && <span className="text-meta text-muted">{hint}</span>}
      </span>
    </label>
  );

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Name">{(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus required />}</Field>
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-label font-medium">Who sees it</legend>
        {option("me", "Only me", false, "A personal view.")}
        {option("everyone", "Everyone", !canShareWithEveryone, canShareWithEveryone ? "Everyone with access to this collection." : "Creators can share a view with everyone.")}
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
          Save as view
        </Button>
      </div>
    </form>
  );
}
