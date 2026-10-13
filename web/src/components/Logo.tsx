import { cn } from "@/lib/cn";

export function Logo({ className, showName = true }: { className?: string; showName?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight text-fg", className)}>
      <svg aria-hidden viewBox="0 0 32 32" className="size-6 shrink-0">
        <rect width="32" height="32" rx="7" className="fill-primary" />
        <g fill="none" strokeWidth="2" className="stroke-primary-fg">
          <rect x="7" y="7" width="18" height="18" rx="2" />
          <path d="M7 13h18M7 19h18M13 7v18" />
        </g>
      </svg>
      {showName && <span>OpenGrid</span>}
    </span>
  );
}
