/**
 * The embeds of a record's Page (REC-6) and how they are stored: a fenced code block whose info string is
 * `openbase`, holding exactly one JSON object.
 *
 *     ```openbase
 *     {"embed":"linked","field":"fldXXXXXXXXXXXXXX"}
 *     ```
 *     ```openbase
 *     {"embed":"view","view":"viwXXXXXXXXXXXXXX","limit":10}
 *     ```
 *
 * The text is written by people, scripts and agents, and read by every client that shows rich text, so reading it
 * is strict: the info string is exactly `openbase`, the JSON is one object with exactly the documented keys of
 * its kind, every id matches the shape of an id, and `limit` is a whole number in range. Anything else is not an
 * embed. The Tiptap node (richtext/embed.ts) and the Markdown renderer (record/Markdown.tsx) both read it here, so
 * they cannot disagree about what a block means. What an embed then shows is decided by who is looking
 * (components/embeds).
 */

/** The info string that marks the block. The server's search skips blocks whose first word is this (core `cell::embed`). */
export const EMBED_INFO = "openbase";

/** How many records a View embed shows when `limit` is left out, and the most it may ask for. */
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/** The longest body read as an embed; a real one is under 100 characters. */
const MAX_TEXT = 512;

/** An id as the server makes them: a prefix and letters or digits (the underscore is for ids made by hand in fixtures). */
const FIELD_ID = /^fld[A-Za-z0-9_]{1,40}$/;
const VIEW_ID = /^viw[A-Za-z0-9_]{1,40}$/;

export type Embed = { embed: "linked"; field: string } | { embed: "view"; view: string; limit: number };

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `keys` is exactly the set `allowed` or `allowed` plus some of `optional` (no other key, no repeats). */
function keysAre(obj: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(obj);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

/**
 * How many keys the top-level object of `body` writes, counting repeats. `JSON.parse` keeps the last value of a
 * repeated key, so a block like `{"view":"anything at all","view":"viwXXXX"}` would read as a valid embed while
 * the first value, which no reader ever sees, carries whatever text it likes. Comparing this count with the keys
 * of the parsed object turns such a block into one that cannot be shown.
 */
function writtenKeyCount(body: string): number {
  let depth = 0;
  let count = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      // A string runs to its closing quote, past escaped ones.
      let j = i + 1;
      while (j < body.length && body[j] !== '"') j += body[j] === "\\" ? 2 : 1;
      let k = j + 1;
      while (k < body.length && /\s/.test(body[k]!)) k++;
      if (depth === 1 && body[k] === ":") count++;
      i = j;
    }
  }
  return count;
}

/**
 * The embed that `text` (the body of an `openbase` block) holds, or null when it is anything else. Never throws and
 * never looks at anything but the text.
 */
export function parseEmbed(text: string): Embed | null {
  const body = text.trim();
  if (body.length === 0 || body.length > MAX_TEXT || !body.startsWith("{")) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(json) || writtenKeyCount(body) !== Object.keys(json).length) return null;
  if (json.embed === "linked") {
    if (!keysAre(json, ["embed", "field"]) || typeof json.field !== "string" || !FIELD_ID.test(json.field)) return null;
    return { embed: "linked", field: json.field };
  }
  if (json.embed === "view") {
    if (!keysAre(json, ["embed", "view"], ["limit"]) || typeof json.view !== "string" || !VIEW_ID.test(json.view)) return null;
    const limit = json.limit === undefined ? DEFAULT_LIMIT : json.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
    return { embed: "view", view: json.view, limit };
  }
  return null;
}

/** The body an embed is stored as, with the keys in the documented order. */
export function embedJson(embed: Embed): string {
  return embed.embed === "linked" ? JSON.stringify({ embed: "linked", field: embed.field }) : JSON.stringify({ embed: "view", view: embed.view, limit: embed.limit });
}

/**
 * Whether a code block's info string marks an embed block, readable or not: its first word is `openbase`, which is
 * what the server's search skips. Only the info string exactly `openbase` can be a readable one (`embedOfBlock`).
 */
export function isEmbedInfo(info: string | null | undefined): boolean {
  return (info ?? "").trim().split(/\s+/)[0] === EMBED_INFO;
}

/** The embed a code block holds: its info string is exactly `openbase` and its body reads as one embed. */
export function embedOfBlock(info: string | null | undefined, body: string): Embed | null {
  return (info ?? "").trim() === EMBED_INFO ? parseEmbed(body) : null;
}
