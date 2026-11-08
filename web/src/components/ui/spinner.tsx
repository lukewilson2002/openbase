import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Icon icon={LoaderCircle} size="fit" className={cn("ob-spin size-4 text-muted", className)} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Centered spinner for page-level loading states. */
export function PageSpinner({ label }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner className="size-6" label={label} />
    </div>
  );
}
