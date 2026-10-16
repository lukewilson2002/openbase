import type { CSSProperties } from "react";
import { Lock } from "lucide-react";
import type { BasePerson } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { Avatar, initials } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";

const MAX_FACES = 4;

function isMe(p: BasePerson, meId: string | undefined): boolean {
  return !p.pending && !!meId && p.user_id === meId;
}

/** "you, Alex, and jordan@example.com (invited, not joined yet)": the full list, for screen readers. */
export function peopleLabel(people: readonly BasePerson[], meId: string | undefined): string {
  const names = people.map((p) => {
    if (isMe(p, meId)) return "you";
    if (p.pending) return `${p.email || p.name || "someone with an invite link"} (invited, not joined yet)`;
    return p.name || p.email;
  });
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** "You, Alex, jordan (invited)": short names, for the line beside the faces. */
export function peopleSummary(people: readonly BasePerson[], meId: string | undefined, max = 3): string {
  const short = people.map((p) => {
    if (isMe(p, meId)) return "You";
    if (p.pending) return `${(p.email || p.name).split("@")[0] || "Someone"} (invited)`;
    return p.name.trim().split(/\s+/)[0] || p.email.split("@")[0] || "Someone";
  });
  // "You" first: the list is about who else is in here.
  const mine = short.indexOf("You");
  if (mine > 0) short.unshift(...short.splice(mine, 1));
  return short.length > max ? `${short.slice(0, max).join(", ")} and ${short.length - max} more` : short.join(", ");
}

/** The face of someone invited who has not joined yet: grey, with a dashed outline. */
export function PendingFace({ email, size = "sm", className, style }: { email?: string | null; size?: "sm" | "md"; className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      data-pending
      style={style}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-faint bg-subtle font-semibold text-muted",
        size === "sm" ? "size-6 text-[0.625rem]" : "size-8 text-xs",
        className,
      )}
    >
      {email ? initials(null, email) : "?"}
    </span>
  );
}

export interface BaseAvatarsProps {
  people: readonly BasePerson[];
  /** Faces drawn before the rest become "+N" (default 4). */
  max?: number;
  /** Show the short names beside the faces. */
  summary?: boolean;
  /** Extra classes for the summary text (e.g. to hide it on phones). */
  summaryClassName?: string;
  /** `md` for the base's header on a desktop. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Who can open a base, as overlapping faces (at most four, then "+N"). Someone invited who has
 * not joined yet is a grey face with a dashed outline. When nobody else can open it: a lock and
 * "Only you".
 */
export function BaseAvatars({ people, max = MAX_FACES, summary = false, summaryClassName, size = "sm", className }: BaseAvatarsProps) {
  const { data: me } = useMe();
  const meId = me?.id;

  if (people.length === 0 || (people.length === 1 && isMe(people[0]!, meId))) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted", className)}>
        <Lock aria-hidden className="size-3.5" /> Only you
      </span>
    );
  }

  // Me first, like the summary line.
  const ordered = [...people].sort((a, b) => Number(isMe(b, meId)) - Number(isMe(a, meId)));
  const faces = ordered.length > max ? ordered.slice(0, Math.max(1, max - 1)) : ordered;
  const rest = ordered.length - faces.length;
  const label = `Who can open this base: ${peopleLabel(ordered, meId)}`;

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span role="img" aria-label={label} title={label} className={cn("flex shrink-0", size === "md" ? "-space-x-2" : "-space-x-1.5")}>
        {/* Leftmost on top, each face tucked under the one before it: the first face (you) reads whole. */}
        {faces.map((p, i) =>
          p.pending ? (
            <PendingFace key={`invite-${i}`} email={p.email || p.name} size={size} className="relative ring-2 ring-surface" style={{ zIndex: faces.length - i + 1 }} />
          ) : (
            <span key={p.user_id ?? i} aria-hidden data-face className="relative inline-flex rounded-full ring-2 ring-surface" style={{ zIndex: faces.length - i + 1 }}>
              <Avatar name={p.name} email={p.email} size={size} />
            </span>
          ),
        )}
        {rest > 0 && (
          <span aria-hidden className={cn("relative z-0 inline-flex shrink-0 items-center justify-center rounded-full bg-subtle font-semibold text-muted ring-2 ring-surface", size === "md" ? "size-8 text-xs" : "size-6 text-[0.625rem]")}>
            +{rest}
          </span>
        )}
      </span>
      {summary && (
        <span aria-hidden className={cn("min-w-0 truncate text-xs text-muted", summaryClassName)}>
          {peopleSummary(ordered, meId)}
        </span>
      )}
    </span>
  );
}
