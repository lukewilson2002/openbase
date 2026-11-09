import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { Logo } from "./Logo";
import { Card } from "./ui/card";

/**
 * The 44 px inputs and buttons of the sign-in pages (APP-1). 16 px text, so iOS does not zoom into a field,
 * and a button as wide as the card.
 */
export const AUTH_INPUT = "h-control-touch text-read-phone";
export const AUTH_BUTTON = "w-full";

/**
 * Centered card for the pages people see before they are signed in (login, setup, signup, invite, password reset):
 * the OpenBase lockup above a 400 px card on the page ground (APP-1, NAV-6). `mark` puts a workspace's color
 * mark beside the title, for the invite and sign-up pages that bring someone to a workspace.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  mark,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  mark?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <Link to="/" className="mb-6 rounded-md" aria-label="OpenBase home">
        <Logo className="h-10" />
      </Link>
      <Card className="w-full max-w-[25rem] p-6 max-md:p-5">
        <div className="flex items-center gap-2.5">
          {mark}
          <h1 className="min-w-0 break-words text-h2">{title}</h1>
        </div>
        {subtitle && <p className="mt-1.5 text-ui text-muted">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </Card>
      {footer && <div className="mt-4 text-center text-ui text-muted">{footer}</div>}
    </main>
  );
}

/** Titled settings section. */
export function Section({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-line bg-surface", className)}>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[0.9375rem]">{title}</h2>
        {description && <p className="mt-0.5 text-[0.8125rem] text-muted">{description}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Inline alert box. */
export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "success" | "warning"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-[0.8125rem]",
        tone === "error" && "border-danger/40 bg-danger-soft text-danger",
        tone === "success" && "border-success/40 bg-success-soft text-success",
        tone === "warning" && "border-line-strong bg-warning-soft",
        tone === "info" && "border-line bg-subtle text-fg",
      )}
    >
      {children}
    </div>
  );
}
