import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { Logo } from "./Logo";

/** Centered card for unauthenticated pages (login, setup, signup, ...). */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link to="/" className="mb-6" aria-label="OpenBase home">
        <Logo className="h-10" />
      </Link>
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-pop">
        <h1 className="text-xl">{title}</h1>
        {subtitle && <p className="mt-1 text-[0.8125rem] text-muted">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
      {footer && <div className="mt-4 text-[0.8125rem] text-muted">{footer}</div>}
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
