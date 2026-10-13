import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "@/api/client";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/input";
import { Notice } from "./layouts";

export interface NameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  label?: string;
  initialValue?: string;
  submitLabel?: string;
  /** Extra form controls rendered below the name input. */
  extra?: ReactNode;
  maxLength?: number;
  onSubmit: (name: string) => void | Promise<unknown>;
}

/** Create/rename dialog with one required text input. Closes when `onSubmit` resolves. */
export function NameDialog({ open, onOpenChange, title, description, label = "Name", initialValue = "", submitLabel = "Save", extra, maxLength = 255, onSubmit }: NameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm">
      <NameForm
        label={label}
        initialValue={initialValue}
        submitLabel={submitLabel}
        extra={extra}
        maxLength={maxLength}
        onSubmit={onSubmit}
        onCancel={() => onOpenChange(false)}
        onDone={() => onOpenChange(false)}
      />
    </Dialog>
  );
}

function NameForm({
  label,
  initialValue,
  submitLabel,
  extra,
  maxLength,
  onSubmit,
  onCancel,
  onDone,
}: {
  label: string;
  initialValue: string;
  submitLabel: string;
  extra?: ReactNode;
  maxLength: number;
  onSubmit: (name: string) => void | Promise<unknown>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = value.trim();
    if (!name) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(name);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label={label}>{(ctl) => <Input {...ctl} value={value} onChange={(e) => setValue(e.target.value)} maxLength={maxLength} autoFocus required />}</Field>
      {extra}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!value.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
