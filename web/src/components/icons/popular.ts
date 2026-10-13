/**
 * The 20 icons offered first in the picker. They are imported statically, so they render at once
 * everywhere (tabs, cards, menus) without loading the ~1,900-icon set (see `registry.ts`).
 *
 * Chosen for what a small business keeps in a database: people and places, money and sales, things
 * that ship, plans and tasks, documents. Names are Lucide's canonical kebab-case names (what the
 * server stores); `icons.test.ts` checks every one of them exists in the full set.
 */
import {
  Briefcase,
  Building,
  Calendar,
  ChartColumn,
  ClipboardList,
  FileText,
  Folder,
  Heart,
  House,
  ListChecks,
  Megaphone,
  Package,
  ShoppingCart,
  Star,
  Store,
  Target,
  Truck,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface PopularIcon {
  name: string;
  Icon: LucideIcon;
}

/** In display order: two rows of ten in the picker. */
export const POPULAR_ICONS: readonly PopularIcon[] = [
  { name: "briefcase", Icon: Briefcase },
  { name: "users", Icon: Users },
  { name: "house", Icon: House },
  { name: "building", Icon: Building },
  { name: "store", Icon: Store },
  { name: "shopping-cart", Icon: ShoppingCart },
  { name: "package", Icon: Package },
  { name: "truck", Icon: Truck },
  { name: "calendar", Icon: Calendar },
  { name: "clipboard-list", Icon: ClipboardList },
  { name: "list-checks", Icon: ListChecks },
  { name: "file-text", Icon: FileText },
  { name: "folder", Icon: Folder },
  { name: "wallet", Icon: Wallet },
  { name: "chart-column", Icon: ChartColumn },
  { name: "target", Icon: Target },
  { name: "star", Icon: Star },
  { name: "heart", Icon: Heart },
  { name: "megaphone", Icon: Megaphone },
  { name: "wrench", Icon: Wrench },
];

export const POPULAR_BY_NAME: ReadonlyMap<string, LucideIcon> = new Map(POPULAR_ICONS.map((p) => [p.name, p.Icon]));

/** "chart-column" -> "Chart column" (the accessible name of an icon button). */
export function humanizeIconName(name: string): string {
  const words = name.replace(/-+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
