/**
 * What a form shows after a submission: the success message and, when the form offers it, "Submit
 * another response". Shared by the public page, "Fill in form" and the builder's preview so the three
 * look and behave alike. A form with a redirect address shows no message: people are on their way.
 */
import type { ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface FormDoneProps {
  /** The success message (or what stands in for it). */
  message: string;
  /** A line under the message. */
  note?: ReactNode;
  /** Shows the "Submit another response" button when given. */
  onAnother?: () => void;
  anotherLabel?: string;
  /** Heading level of the message: the public page has no other heading, the app has its own. */
  level?: 1 | 2;
  className?: string;
}

export function FormDone({ message, note, onAnother, anotherLabel = "Submit another response", level = 2, className }: FormDoneProps) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div role="status" className={cn("mx-auto flex w-full flex-col items-center gap-3 border border-line bg-surface p-8 text-center", className)}>
      <CircleCheck aria-hidden className="size-8 text-success" />
      <Heading className="text-xl">{message}</Heading>
      {note && <div className="text-[0.8125rem] text-muted">{note}</div>}
      {onAnother && (
        <Button variant="primary" onClick={onAnother}>
          {anotherLabel}
        </Button>
      )}
    </div>
  );
}
