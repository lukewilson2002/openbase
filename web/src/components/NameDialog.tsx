import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "@/api/client";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/input";
import { Notice } from "./layouts";
import { ColorField } from "./ColorField";
import type { ChoiceColor } from "@/lib/colors";

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
  /** Put a colour picker under the name (for creating a workspace or a project). */
  withColor?: boolean;
  /** `color` is the chosen colour, or `null` when none was picked (the server then chooses). */
  onSubmit: (name: string, color: ChoiceColor | null) => void | Promise<unknown>;
}

/** Create/rename dialog with one required text input and, optionally, a colour. Closes when `onSubmit` resolves. */
export function NameDialog({ open, onOpenChange, title, description, label = "Name", initialValue = "", submitLabel = "Save", extra, maxLength = 255, withColor = false, onSubmit }: NameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm">
      <NameForm
        label={label}
        initialValue={initialValue}
        submitLabel={submitLabel}
        extra={extra}
        maxLength={maxLength}
        withColor={withColor}
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
  withColor,
  onSubmit,
  onCancel,
  onDone,
}: {
  label: string;
  initialValue: string;
  submitLabel: string;
  extra?: ReactNode;
  maxLength: number;
  withColor: boolean;
  onSubmit: (name: string, color: ChoiceColor | null) => void | Promise<unknown>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [color, setColor] = useState<ChoiceColor | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = value.trim();
    if (!name) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(name, color);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label={label}>
        {(ctl) => (
          <Input {...ctl} value={value} onChange={(e) => setValue(e.target.value)} maxLength={maxLength} autoFocus required />
        )}
      </Field>
      {withColor && <ColorField value={color} onChange={setColor} />}
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
