import type { BaseSummary } from "@/api/types";

export interface BaseAccess {
  role: string;
  all_bases: boolean;
  base_ids: readonly string[];
}

/** "All bases", "All bases, incl. new", "Chores only", "2 of 5 bases": what someone can open. */
export function accessSummary(access: BaseAccess, bases: readonly Pick<BaseSummary, "id" | "name">[]): string {
  if (access.role === "owner") return "All bases";
  if (access.all_bases) return "All bases, incl. new";
  // Ids of bases deleted since are not worth counting.
  const picked = bases.filter((b) => access.base_ids.includes(b.id));
  if (picked.length === 0) return "No bases";
  if (picked.length === 1) return `${picked[0]!.name} only`;
  return `${picked.length} of ${bases.length} bases`;
}
