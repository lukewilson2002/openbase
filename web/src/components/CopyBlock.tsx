import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/format";
import { Button } from "./ui/button";

/** A read-only, scrollable block of text or code (commands, configuration) with a copy button. */
export function CopyBlock({ value, label, copyLabel = "Copy" }: { value: string; label: string; copyLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-line bg-subtle">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-xs font-medium text-muted">{label}</span>
        <Button
          size="sm"
          aria-label={copied ? "Copied" : copyLabel}
          onClick={() => {
            void copyToClipboard(value).then((ok) => {
              setCopied(ok);
              if (ok) setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
          {copied ? "Copied" : copyLabel}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={label} className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed">
        {value}
      </pre>
    </div>
  );
}
