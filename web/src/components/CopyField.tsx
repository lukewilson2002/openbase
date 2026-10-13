import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Read-only text with a copy button (invite links, API tokens, reset links). */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
      <Button
        onClick={() => {
          void copyToClipboard(value).then((ok) => {
            setCopied(ok);
            if (ok) setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
