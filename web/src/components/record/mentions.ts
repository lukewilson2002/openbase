/** Comment bodies are plain text; mentions are written `@[Name](usrXXXX)` (og_core::api::records::Comment). */

export interface Mention {
  userId: string;
  name: string;
}

export type CommentPart = { kind: "text"; text: string } | { kind: "mention"; userId: string; name: string };

const MENTION = /@\[([^\]\n]{1,200})\]\((usr[A-Za-z0-9]{1,40})\)/g;

/** Split a comment body into text and mention parts (everything else stays plain text). */
export function parseComment(body: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: "text", text: body.slice(last, start) });
    parts.push({ kind: "mention", userId: m[2]!, name: m[1]! });
    last = start + m[0].length;
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  return parts;
}

/** Ids of everyone mentioned in a body (deduplicated, in order). */
export function mentionedUserIds(body: string): string[] {
  const out: string[] = [];
  for (const p of parseComment(body)) if (p.kind === "mention" && !out.includes(p.userId)) out.push(p.userId);
  return out;
}

/** The markup that inserts a mention. Square brackets in names are removed so the markup stays parseable. */
export function mentionMarkup(m: Mention): string {
  return `@[${m.name.replace(/[[\]\n]/g, "")}](${m.userId})`;
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

/** Replace the open `@query` with a mention and a trailing space; returns the new text and caret. */
export function insertMention(text: string, caret: number, open: OpenMention, m: Mention): { text: string; caret: number } {
  const markup = `${mentionMarkup(m)} `;
  const next = `${text.slice(0, open.start)}${markup}${text.slice(caret)}`;
  return { text: next, caret: open.start + markup.length };
}

/** Plain-text form of a body ("@Name" instead of the markup), for notifications and previews. */
export function plainComment(body: string): string {
  return parseComment(body)
    .map((p) => (p.kind === "text" ? p.text : `@${p.name}`))
    .join("");
}
