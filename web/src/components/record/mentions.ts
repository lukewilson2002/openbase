/**
 * @mentions in Markdown, as comments and rich text store them: `@[Name](usrXXXX)`, an `@` right
 * before a link to a user id (the server reads them the same way, store/mentions.rs). The name is only
 * a label; the id counts. The rich text editor makes them a node (richtext/mention.ts) and Markdown.tsx
 * shows them as chips.
 */

export interface Mention {
  userId: string;
  name: string;
}

export type MentionPart = { kind: "text"; text: string } | { kind: "mention"; userId: string; name: string };

const SOURCE = String.raw`@\[([^\]\n]{1,200})\]\((usr[A-Za-z0-9]{1,40})\)`;
const MENTION = new RegExp(SOURCE, "g");

/** A mention at the very start of `src`: the label in [1], the user id in [2]. */
export const MENTION_AT_START = new RegExp(`^${SOURCE}`);

/** Split a text into plain parts and mention parts (no Markdown is read, only the mention markup). */
export function parseMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
    parts.push({ kind: "mention", userId: m[2]!, name: m[1]! });
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** Ids of everyone mentioned in a text (deduplicated, in order). */
export function mentionedUserIds(text: string): string[] {
  const out: string[] = [];
  for (const p of parseMentions(text)) if (p.kind === "mention" && !out.includes(p.userId)) out.push(p.userId);
  return out;
}

/**
 * The markup of a mention. Brackets, backslashes and line breaks are removed from the name, so the
 * markup stays one link to Markdown (a `\]` would escape the bracket that closes it).
 */
export function mentionMarkup(m: Mention): string {
  return `@[${m.name.replace(/[[\]\\\n]/g, "").trim() || "someone"}](${m.userId})`;
}

export interface OpenMention {
  /** Index of the `@`. */
  start: number;
  query: string;
}

/** The `@name` being typed at `caret`, if any (an `@` at a word start with no whitespace after it). */
export function openMention(text: string, caret: number): OpenMention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (!/^[^\s@[\]()]{0,40}$/.test(query)) return null;
  return { start: at, query };
}

/** The people whose name contains `query` or whose email starts with it, at most `max`. */
export function matchPeople<P extends { name: string; email: string }>(people: readonly P[], query: string, max = 6): P[] {
  const q = query.toLowerCase();
  return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().startsWith(q)).slice(0, max);
}
