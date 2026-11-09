/**
 * Chrome of the public pages (shared views and forms): outside the app shell, no account menu,
 * no navigation into the app. Header with what is shared (its name beside the collection's color
 * mark), the content, and the small "Powered by OpenBase" footer mark (APP-6, APP-7). A form is a
 * 640 px column, a shared view is as wide as its layout needs.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Lock, TriangleAlert } from "lucide-react";
import { BrandMark } from "@/components/Logo";
import { AUTH_BUTTON, AUTH_INPUT } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { PublicProblem } from "@/lib/publicErrors";

export function PublicShell({
  title,
  subtitle,
  mark,
  children,
  wide,
  hideHeader,
}: {
  title?: string;
  subtitle?: ReactNode;
  /** The collection's ColorMark, drawn beside the title. */
  mark?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** The page draws its own heading (a form puts the title inside its card). */
  hideHeader?: boolean;
}) {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · OpenBase` : "OpenBase";
    return () => {
      document.title = previous;
    };
  }, [title]);
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <main className={cn("mx-auto flex w-full flex-1 flex-col px-4 py-6 sm:py-10", wide ? "max-w-[96rem] md:px-10" : "max-w-[calc(40rem+2rem)]")}>
        {!hideHeader && (title || subtitle) && (
          <header className="mb-4">
            {title && (
              <h1 className="flex min-w-0 items-center gap-2.5 text-h2">
                {mark}
                <span className="min-w-0 break-words">{title}</span>
              </h1>
            )}
            {subtitle && <p className="mt-1 text-label text-muted">{subtitle}</p>}
          </header>
        )}
        {children}
      </main>
      <footer className="border-t border-line px-4 py-4 text-center text-meta text-muted">
        <span className="inline-flex items-center gap-1.5">
          Powered by <BrandMark small className="size-4" />
          <span className="font-medium text-fg">OpenBase</span>
        </span>
      </footer>
    </div>
  );
}

export function PublicLoading() {
  return (
    <PublicShell>
      <PageSpinner label="Loading" />
    </PublicShell>
  );
}

export function PublicProblemScreen({ problem, onRetry }: { problem: Extract<PublicProblem, { title: string }>; onRetry?: () => void }) {
  const retryable = problem.kind === "rate_limited" || problem.kind === "offline" || problem.kind === "other";
  return (
    <PublicShell>
      <EmptyState
        icon={<TriangleAlert />}
        title={problem.title}
        description={problem.message}
        action={retryable && onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
        className="py-20"
      />
    </PublicShell>
  );
}

/** Asks for the share password. It is kept in memory by the page; nothing is stored. */
export function PasswordPrompt({ what, invalid, checking, onSubmit }: { what: "form" | "page"; invalid: boolean; checking: boolean; onSubmit: (password: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onSubmit(value);
  };
  return (
    <PublicShell>
      <Card className="mx-auto mt-10 w-full max-w-[25rem] p-6 max-md:p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Lock aria-hidden className="size-5 text-muted" />
            <h1 className="text-h2">This {what} is password protected</h1>
          </div>
          <Field label="Password" error={invalid ? "That password is not correct. Try again." : undefined}>
            {(ctl) => <Input {...ctl} className={AUTH_INPUT} type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" size="lg" className={AUTH_BUTTON} loading={checking} disabled={!value}>
            Continue
          </Button>
        </form>
      </Card>
    </PublicShell>
  );
}
