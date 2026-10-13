import { useState, type ReactNode } from "react";
import { AlertDialog as A } from "radix-ui";
import { errorMessage } from "@/api/client";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  /** Runs on confirm; the dialog stays open (with the error) if it throws. */
  onConfirm: () => void | Promise<unknown>;
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", destructive, onConfirm }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    if (!next) setError(null);
    onOpenChange(next);
  };

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <A.Root open={open} onOpenChange={handleOpenChange}>
      <A.Portal>
        <A.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <A.Content className="ob-pop-in fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-4 shadow-pop">
          <A.Title className="text-base font-semibold">{title}</A.Title>
          <A.Description className="mt-1 text-[0.8125rem] text-muted">{description ?? "Are you sure?"}</A.Description>
          {error && (
            <p role="alert" className="mt-3 text-[0.8125rem] text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <A.Cancel asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </A.Cancel>
            <Button variant={destructive ? "danger" : "primary"} loading={pending} onClick={() => void confirm()}>
              {confirmLabel}
            </Button>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
