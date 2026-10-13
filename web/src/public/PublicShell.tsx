/**
 * Chrome of the public pages (shared views and forms): outside the app shell, no account menu,
 * no navigation into the app. Header with what is shared, the content, and the "Powered by
 * OpenGrid" footer.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Lock, TriangleAlert } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { PublicProblem } from "@/lib/publicErrors";

export function PublicShell({ title, subtitle, children, wide }: { title?: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · OpenGrid` : "OpenGrid";
    return () => {
      document.title = previous;
    };
  }, [title]);
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <main className={cn("mx-auto flex w-full flex-1 flex-col px-4 py-6 sm:py-10", wide ? "max-w-[96rem]" : "max-w-2xl")}>
        {(title || subtitle) && (
          <header className="mb-4">
            {title && <h1 className="text-xl">{title}</h1>}
            {subtitle && <p className="text-[0.8125rem] text-muted">{subtitle}</p>}
          </header>
        )}
        {children}
      </main>
      <footer className="border-t border-line px-4 py-3 text-center text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          Powered by <Logo className="text-xs" />
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
      <form onSubmit={submit} className="mx-auto mt-10 flex w-full max-w-sm flex-col gap-4 rounded-lg border border-line bg-surface p-6 shadow-pop">
        <div className="flex items-center gap-2">
          <Lock aria-hidden className="size-5 text-muted" />
          <h1 className="text-lg">This {what} is password protected</h1>
        </div>
        <Field label="Password" error={invalid ? "That password is not correct. Try again." : undefined}>
          {(ctl) => <Input {...ctl} type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={checking} disabled={!value}>
          Continue
        </Button>
      </form>
    </PublicShell>
  );
}
