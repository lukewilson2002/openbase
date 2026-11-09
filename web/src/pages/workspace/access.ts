import type { BaseSummary } from "@/api/types";

export interface BaseAccess {
  role: string;
  all_bases: boolean;
  base_ids: readonly string[];
}

/**
 * "All folders", "Chores only", "2 of 5 folders": what someone can open (the top level counts as one, named
 * "Top level" by the caller). "All folders" includes folders made later; someone who has each one picked reads
 * "3 of 3 folders". Only owners see every folder and everyone's full list (`precise`); anyone else gets
 * "All folders" or "Some folders", since counting the ones they can see would understate what others can open.
 */
export function accessSummary(access: BaseAccess, bases: readonly Pick<BaseSummary, "id" | "name">[], precise = true): string {
  if (access.role === "owner" || access.all_bases) return "All folders";
  if (!precise) return "Some folders";
  // Ids of bases deleted since are not worth counting.
  const picked = bases.filter((b) => access.base_ids.includes(b.id));
  if (picked.length === 0) return "No folders";
  if (picked.length === 1) return `${picked[0]!.name} only`;
  return `${picked.length} of ${bases.length} folders`;
}
