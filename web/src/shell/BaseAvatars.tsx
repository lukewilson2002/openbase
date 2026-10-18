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

/** "you, Alex, and jordan@example.com (invited, not joined yet)": the names behind some faces, for tooltips and screen readers. */
export function peopleLabel(people: readonly BasePerson[], meId: string | undefined, limit = 8): string {
  const named = people.map((p) => {
    if (isMe(p, meId)) return "you";
    if (p.pending) return `${p.email || p.name || "someone with an invite link"} (invited, not joined yet)`;
    return p.name || p.email;
  });
  const shown = named.slice(0, limit);
  if (named.length > limit) shown.push(`${named.length - limit} more`);
  if (shown.length <= 1) return shown.join("");
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
  return `${shown.slice(0, -1).join(", ")}, and ${shown[shown.length - 1]}`;
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
  /** Everyone who can open the project, invites that are not accepted yet included. */
  people: readonly BasePerson[];
  /** The ids of the people with the project open right now (`usePresence`); you are always counted in. */
  viewers?: readonly string[];
  /** Faces drawn for the people viewing (default 4); any further viewers stay in the "+N". */
  max?: number;
  /** `md` for the project's header on a desktop. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Who is in the project, like the faces at the top of a shared document: one face for each person
 * viewing it right now (you first, then the others in the order they arrived), then one grey "+N" for
 * everyone else who can open it, invites that are not accepted yet included. When nobody else can open
 * it: a lock and "Only you".
 */
export function BaseAvatars({ people, viewers = [], max = MAX_FACES, size = "sm", className }: BaseAvatarsProps) {
  const { data: me } = useMe();
  const meId = me?.id;

  if (people.length === 0 || (people.length === 1 && isMe(people[0]!, meId))) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted", className)}>
        <Lock aria-hidden className="size-3.5" /> Only you
      </span>
    );
  }

  // I count even before the first presence frame has come in, so the faces never start empty.
  const byId = new Map(people.filter((p) => !p.pending && p.user_id).map((p) => [p.user_id!, p] as const));
  const watching = [...new Set([...(meId ? [meId] : []), ...viewers])].flatMap((id) => byId.get(id) ?? []);
  const faces = watching.slice(0, max);
  const rest = people.length - faces.length;
  const away = people.filter((p) => !watching.includes(p));
  const label =
    `${watching.length} ${watching.length === 1 ? "person" : "people"} viewing now` +
    (away.length > 0 ? `, ${away.length} more can open this project` : "") +
    (watching.length > 0 ? `: ${peopleLabel(watching, meId)}` : "");
  const chipSize = size === "md" ? "size-8 text-xs" : "size-6 text-[0.625rem]";

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span role="img" aria-label={label} title={label} className={cn("flex shrink-0", size === "md" ? "-space-x-2" : "-space-x-1.5")}>
        {/* Leftmost on top, each face tucked under the one before it: the first face (you) reads whole. */}
        {faces.map((p, i) => (
          <span key={p.user_id ?? i} aria-hidden data-face className="relative inline-flex rounded-full ring-2 ring-surface" style={{ zIndex: faces.length - i + 1 }}>
            <Avatar name={p.name} email={p.email} size={size} />
          </span>
        ))}
        {rest > 0 && (
          <span
            aria-hidden
            data-away
            title={away.length > 0 ? `Can open this project, not viewing now: ${peopleLabel(away, meId)}` : undefined}
            className={cn("relative z-0 inline-flex shrink-0 items-center justify-center rounded-full bg-subtle font-semibold text-muted ring-2 ring-surface", chipSize)}
          >
            +{rest}
          </span>
        )}
      </span>
    </span>
  );
}
