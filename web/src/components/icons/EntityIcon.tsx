import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "lucide-react";
import { cn } from "@/lib/cn";
import { accentClass } from "@/lib/colors";
import { workspaceColor } from "@/lib/workspaceColor";
import { POPULAR_BY_NAME } from "./popular";
import { peekFullIconSet, requestFullIconSet, subscribeIconSet } from "./registry";

/** First letter of a name, upper-cased: the fallback shown where an icon would be. */
export function entityLetter(name: string | null | undefined): string {
  return name?.trim().charAt(0).toUpperCase() || "?";
}

export interface EntityIconProps {
  /** Lucide icon name (kebab-case) as stored on the workspace, base or table. */
  name?: string | null;
  /** Shown instead of the icon when there is none, it is unknown, or its chunk is still loading. */
  fallbackLetter?: string;
  className?: string;
}

/**
 * A workspace, base or table icon by name. The 20 popular icons are bundled and draw immediately;
 * any other name triggers a one-time lazy load of the full set (cached for the session) and shows
 * `fallbackLetter` (or nothing) until it arrives. Decorative: the entity's name is always next to it.
 */
export function EntityIcon({ name, fallbackLetter, className }: EntityIconProps) {
  const popular = name ? POPULAR_BY_NAME.get(name) : undefined;
  const needsSet = !!name && !popular;
  const set = useSyncExternalStore(subscribeIconSet, peekFullIconSet, () => null);
  useEffect(() => {
    if (needsSet && !set) requestFullIconSet();
  }, [needsSet, set]);

  if (popular) {
    const Popular = popular;
    return <Popular aria-hidden data-icon={name} className={cn("shrink-0", className)} />;
  }
  const node = name && !popular && set ? set.nodes.get(name) : undefined;
  if (node) return <Icon iconNode={node} aria-hidden data-icon={name} className={cn("shrink-0", className)} />;
  return fallbackLetter ? (
    <span aria-hidden className="leading-none">
      {fallbackLetter}
    </span>
  ) : null;
}

const TILE_SIZES = {
  xs: { box: "size-5 rounded-[5px] text-[0.6875rem]", icon: "size-3" },
  sm: { box: "size-6 rounded-md text-xs", icon: "size-3.5" },
  md: { box: "size-8 rounded-lg text-sm", icon: "size-[1.125rem]" },
  lg: { box: "size-11 rounded-xl text-xl", icon: "size-6" },
} as const;

export type EntityTileSize = keyof typeof TILE_SIZES;

/**
 * The coloured square for a base or a workspace: its icon, or the first letter of its name when
 * it has none. A base's is a soft tint of its colour (`tint`); a workspace's is solid with a white
 * initial (`solid`, see WorkspaceTile). Without a colour it is neutral.
 */
export function EntityTile({
  name,
  icon,
  color,
  variant = "tint",
  size = "md",
  className,
}: {
  name: string;
  icon?: string | null;
  color?: string | null;
  variant?: "tint" | "solid";
  size?: EntityTileSize;
  className?: string;
}) {
  const s = TILE_SIZES[size];
  return (
    <span aria-hidden data-entity-tile className={cn("flex shrink-0 items-center justify-center font-bold", s.box, color ? accentClass(color, variant) : "bg-subtle text-muted", className)}>
      <EntityIcon name={icon} fallbackLetter={entityLetter(name)} className={s.icon} />
    </span>
  );
}

/** A workspace's solid tile in its colour (its own, or one picked from its name until it has one). */
export function WorkspaceTile({ ws, size = "sm", className }: { ws: { name: string; icon?: string | null; color?: string | null }; size?: EntityTileSize; className?: string }) {
  return <EntityTile name={ws.name} icon={ws.icon} color={workspaceColor(ws)} variant="solid" size={size} className={className} />;
}

/** A name with its icon to the left (nothing extra when the entity has no icon, unless `reserveIcon` keeps a list aligned). */
export function EntityLabel({ icon, children, className, iconClassName, reserveIcon }: { icon?: string | null; children: ReactNode; className?: string; iconClassName?: string; reserveIcon?: boolean }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {icon ? <EntityIcon name={icon} className={cn("size-4 text-muted", iconClassName)} /> : reserveIcon ? <span aria-hidden className={cn("size-4 shrink-0", iconClassName)} /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
