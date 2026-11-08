/**
 * Finding property names in a phrase. A name matches as a run of whole words, ignoring case,
 * accents and punctuation: "follow-up" finds "Next follow-up" ("follow" and "up" are both words of
 * the name, in order). The whole name beats its first words, which beat words from the middle.
 */
import type { Field } from "@/api/types";
import { wordsOf, type Token } from "./tokens";

export type Quality = "exact" | "prefix" | "partial";

export interface PropertyMatch {
  field: Field;
  /** Where the field sits in the collection's property order, for breaking ties. */
  index: number;
  quality: Quality;
  /** How many of the name's words the phrase used. */
  words: number;
  /** The tokens the name covers: `[startToken, endToken)`. */
  startToken: number;
  endToken: number;
}

interface FlatWord {
  w: string;
  token: number;
  first: boolean;
  last: boolean;
}

/** Punctuation that may sit between the words of a name: "Sales & marketing", "Follow - up". */
const BRIDGES = new Set(["-", "–", "—", "/", "&", "+", "_"]);

function flatten(tokens: readonly Token[]): FlatWord[] {
  const out: FlatWord[] = [];
  tokens.forEach((t, token) => {
    if (t.kind !== "word") return;
    t.words.forEach((w, k) => out.push({ w, token, first: k === 0, last: k === t.words.length - 1 }));
  });
  return out;
}

function adjacent(tokens: readonly Token[], a: FlatWord, b: FlatWord): boolean {
  if (a.token === b.token) return true;
  for (let t = a.token + 1; t < b.token; t++) {
    const between = tokens[t]!;
    if (!(between.kind === "word" && between.words.length === 0 && BRIDGES.has(between.key))) return false;
  }
  return true;
}

export function findPropertyMatches(tokens: readonly Token[], fields: readonly { field: Field; index: number }[]): PropertyMatch[] {
  const flat = flatten(tokens);
  const out: PropertyMatch[] = [];
  for (const { field, index } of fields) {
    const name = wordsOf(field.name);
    if (name.length === 0) continue;
    for (let i = 0; i < flat.length; i++) {
      if (!flat[i]!.first) continue;
      for (let k = 0; k < name.length; k++) {
        if (flat[i]!.w !== name[k]) continue;
        // A run is found from its left end only, so one alignment is not reported once per word.
        if (k > 0 && i > 0 && flat[i - 1]!.w === name[k - 1] && adjacent(tokens, flat[i - 1]!, flat[i]!)) continue;
        let len = 1;
        while (k + len < name.length && i + len < flat.length && flat[i + len]!.w === name[k + len] && adjacent(tokens, flat[i + len - 1]!, flat[i + len]!)) len++;
        // Whole words only: the run ends where a typed word ends.
        while (len > 0 && !flat[i + len - 1]!.last) len--;
        if (len === 0) continue;
        const quality: Quality = len === name.length ? "exact" : k === 0 ? "prefix" : "partial";
        out.push({ field, index, quality, words: len, startToken: flat[i]!.token, endToken: flat[i + len - 1]!.token + 1 });
      }
    }
  }
  return out;
}
