import { useId } from "react";
import { cn } from "@/lib/cn";
import { ACCESS_HINT, ACCESS_LABEL, ACCESS_ORDER, type OAuthAccess } from "@/lib/oauthAccess";

export interface AccessChoiceProps {
  value: OAuthAccess;
  onChange: (access: OAuthAccess) => void;
  /** The levels on offer, lowest first; all three by default. */
  levels?: readonly OAuthAccess[];
  /** Names for the levels where they differ from the consent screen's (an API token says Full access). */
  labels?: Record<OAuthAccess, string>;
  /** Levels that are listed but cannot be picked now, with the reason, which also describes the row. */
  disabled?: Partial<Record<OAuthAccess, string>>;
  /** The group's accessible name. */
  label?: string;
}

/**
 * Read, Read and write, or Full control, each with one plain sentence on what it allows: the one chooser of the
 * consent screen, of Change access and of a new API token (AGT-2, AGT-5). Native radios in one group, the label
 * covering the row so a tap anywhere on it chooses.
 */
export function AccessChoice({ value, onChange, levels = ACCESS_ORDER, labels = ACCESS_LABEL, disabled, label = "Access" }: AccessChoiceProps) {
  const uid = useId();
  const name = `access-${uid}`;
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {levels.map((level) => {
        const reason = disabled?.[level];
        return (
          <label
            key={level}
            className={cn(
              "flex min-h-control-touch cursor-pointer items-start gap-3 rounded-md border border-line-strong p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:disabled]:cursor-default has-[:disabled]:opacity-60",
            )}
          >
            <input
              type="radio"
              name={name}
              value={level}
              checked={value === level}
              disabled={reason !== undefined}
              onChange={() => onChange(level)}
              aria-labelledby={`${name}-${level}`}
              aria-describedby={`${name}-${level}-hint`}
              className="m-0 mt-0.5 size-5 shrink-0 accent-[var(--primary)]"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={`${name}-${level}`} className="text-ui font-medium">
                {labels[level]}
              </span>
              <span id={`${name}-${level}-hint`} className="text-label text-muted">
                {ACCESS_HINT[level]}
                {reason ? ` ${reason}` : ""}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
