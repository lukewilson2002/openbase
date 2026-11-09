import { cn } from "@/lib/cn";
import { accentClass, personColor } from "@/lib/colors";

/** Up to two initials from a display name (falls back to the email local part). */
export function initials(name: string | null | undefined, email?: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** Stable colour per identity, so the same person always looks the same. */
export const avatarColor = personColor;

export interface AvatarProps {
  name?: string | null;
  email?: string | null;
  size?: "sm" | "md" | "lg";
  /** The person's colour when the caller knows their base's assignment (`personColors`); else hashed from the email. */
  color?: string | null;
  /** The signed-in person's own face: in the colour they picked for the app (the primary), on their screen only. */
  own?: boolean;
  /** Next to the person's name in text (a menu button, a row): the face adds nothing for assistive technology, so it is hidden from it. */
  decorative?: boolean;
  className?: string;
}

const sizes = { sm: "size-6 text-initial", md: "size-8 text-xs", lg: "size-12 text-base" };

/**
 * A person's face: white initials on a solid circle of their colour, in the accent shades the
 * workspace tiles use, which keep white text readable in both themes.
 */
export function Avatar({ name, email, size = "md", color, own, decorative, className }: AvatarProps) {
  const label = (name ?? "").trim() || email || "User";
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label, title: label })}
      // The initials are generated content, not text: a button that is named by something else (an account menu, a link to the
      // members) then has no drawn text of the face's that its name would have to contain (WCAG 2.5.3).
      data-initials={initials(name, email)}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold before:content-[attr(data-initials)]",
        own ? "bg-primary text-primary-fg" : accentClass(color ?? avatarColor(email || label), "solid"),
        sizes[size],
        className,
      )}
    />
  );
}
