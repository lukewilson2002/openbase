import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "@/api/client";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/input";
import { Notice } from "./layouts";
import { ColorField } from "./ColorField";
import { IconPicker } from "./icons/IconPicker";
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
  /** Put an icon picker beside the name (omit it for people who may not change the icon). */
  withIcon?: boolean;
  /** The icon the entity has now (the picker starts there). */
  initialIcon?: string | null;
  /** Put a colour picker under the name (for creating a workspace or a project). */
  withColor?: boolean;
  /** `icon` is the chosen icon name, or `null` for none; it equals `initialIcon` when untouched. `color` is the chosen colour, or `null` when none was picked (the server then chooses). */
  onSubmit: (name: string, icon: string | null, color: ChoiceColor | null) => void | Promise<unknown>;
}

/** Create/rename dialog with one required text input and, optionally, an icon and a colour. Closes when `onSubmit` resolves. */
export function NameDialog({ open, onOpenChange, title, description, label = "Name", initialValue = "", submitLabel = "Save", extra, maxLength = 255, withIcon = false, initialIcon = null, withColor = false, onSubmit }: NameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm">
      <NameForm
        label={label}
        initialValue={initialValue}
        submitLabel={submitLabel}
        extra={extra}
        maxLength={maxLength}
        withIcon={withIcon}
        initialIcon={initialIcon}
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
  withIcon,
  initialIcon,
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
  withIcon: boolean;
  initialIcon: string | null;
  withColor: boolean;
  onSubmit: (name: string, icon: string | null, color: ChoiceColor | null) => void | Promise<unknown>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [icon, setIcon] = useState<string | null>(initialIcon);
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
      await onSubmit(name, icon, color);
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
          <div className="flex items-center gap-2">
            {withIcon && <IconPicker value={icon} onChange={setIcon} label={icon ? "Change icon" : "Choose icon"} disabled={pending} />}
            <Input {...ctl} value={value} onChange={(e) => setValue(e.target.value)} maxLength={maxLength} autoFocus required />
          </div>
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
