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
  className?: string;
}

const sizes = { sm: "size-6 text-[0.625rem]", md: "size-8 text-xs", lg: "size-12 text-base" };

/**
 * A person's face: white initials on a solid circle of their colour, in the accent shades the
 * workspace tiles use, which keep white text readable in both themes.
 */
export function Avatar({ name, email, size = "md", className }: AvatarProps) {
  const label = (name ?? "").trim() || email || "User";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold", accentClass(avatarColor(email || label), "solid"), sizes[size], className)}
    >
      {initials(name, email)}
    </span>
  );
}
