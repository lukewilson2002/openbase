import { POPULAR_ICONS } from "./popular";
import type { FullIconSet } from "./registry";

/** Rank of how well one search word matches an icon name or one of its aliases (lower is better; null = no match). */
function wordScore(word: string, name: string, aliases: readonly string[]): number | null {
  if (name === word) return 0;
  if (name.startsWith(word)) return 1;
  const parts = name.split("-");
  if (parts.some((p) => p.startsWith(word))) return 2;
  if (name.includes(word)) return 3;
  let best: number | null = null;
  for (const alias of aliases) {
    const s = alias === word ? 4 : alias.startsWith(word) ? 5 : alias.split("-").some((p) => p.startsWith(word)) ? 6 : alias.includes(word) ? 7 : null;
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

/**
 * Icon names matching `query`, best first. The query is split into words and every word has to match
 * the icon's name or an alias ("cart shop" finds "shopping-cart"; "home" finds "house" through its
 * alias). Without the full set loaded, only the popular icons are searched.
 */
export function searchIcons(set: FullIconSet | null, query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return set ? [...set.names] : POPULAR_ICONS.map((p) => p.name);
  const names = set ? set.names : POPULAR_ICONS.map((p) => p.name);
  const hits: { name: string; score: number }[] = [];
  for (const name of names) {
    const aliases = set?.aliases.get(name) ?? [];
    let total = 0;
    let ok = true;
    for (const w of words) {
      const s = wordScore(w, name, aliases);
      if (s === null) {
        ok = false;
        break;
      }
      total += s;
    }
    if (ok) hits.push({ name, score: total });
  }
  hits.sort((a, b) => a.score - b.score || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  return hits.map((h) => h.name);
}
