import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/** A sentence that ends in a full stop, whatever the server's message did (APP-17). */
export function asSentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export interface ErrorStateProps {
  /** What this is, in a few words: "Page not found", "Could not load this folder". */
  title: string;
  /** One sentence on what happened. */
  happened: string;
  /** One sentence on what to do about it. */
  todo: string;
  /** The whole screen is this message (not found, a crash): it is the page's one h1 and its main landmark. */
  fullScreen?: boolean;
  className?: string;
}

/**
 * The not-found and error screens (APP-17): an EmptyState whose line says what happened and what to do, and whose one
 * action leads Home, which every signed-in person can open.
 */
export function ErrorState({ title, happened, todo, fullScreen, className }: ErrorStateProps) {
  const state = (
    <EmptyState
      as={fullScreen ? "h1" : "h3"}
      title={title}
      description={`${asSentence(happened)} ${asSentence(todo)}`}
      action={
        <Button asChild variant="primary">
          <Link to="/">Go to Home</Link>
        </Button>
      }
      className={className}
    />
  );
  return fullScreen ? <main>{state}</main> : state;
}
