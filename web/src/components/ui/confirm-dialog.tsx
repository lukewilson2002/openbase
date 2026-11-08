import { useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@/api/client";
import { Button } from "./button";
import { Dialog } from "./dialog";

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

/**
 * A question with two answers, on `Dialog`: centered on a desktop, a bottom sheet on a phone (APP-16). It is
 * read out as an alert dialog, a press outside does not answer it, and focus starts on Cancel so Enter never
 * confirms by accident.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", destructive, onConfirm }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);

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
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={description ?? "Are you sure?"}
      size="sm"
      role="alertdialog"
      dismissOnOutsidePress={false}
      hideClose
      phone="bottom"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        cancel.current?.focus();
      }}
      footer={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? "danger" : "primary"} loading={pending} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-label text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
