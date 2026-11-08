/**
 * What a collection calls its records (COL-1, COL-10): the singular the creator typed ("client"), or
 * "record" when none is set. Plural for sentences like "Showing 3 of 12 clients."
 */

/** The English plural of a regular noun: client to clients, company to companies, box to boxes. */
export function pluralize(noun: string): string {
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/** The record name of a collection as typed, or "record". */
export function recordNoun(table: { record_noun?: string | null }): string {
  return table.record_noun?.trim() || "record";
}

/** "client" for one record, "clients" for any other number. */
export function recordNounFor(table: { record_noun?: string | null }, count: number): string {
  const noun = recordNoun(table);
  return count === 1 ? noun : pluralize(noun);
}
