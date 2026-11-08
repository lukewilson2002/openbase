/**
 * Splitting a typed phrase into tokens that still know where they came from, so a value such as
 * `Notes contain Follow-up, Q4` can be handed on exactly as typed while property names, operators
 * and choices are compared case-, accent- and punctuation-insensitively.
 */

export type TokenKind = "word" | "symbol" | "quoted";

export interface Token {
  kind: TokenKind;
  /** The text as typed. */
  text: string;
  /** Offsets into the typed phrase. */
  start: number;
  end: number;
  /**
   * What operators are matched on: lower case, apostrophes dropped, edge punctuation trimmed.
   * Symbols are normalised: `==` is `=`, `≥` is `>=`, `≤` is `<=`, and `<>` and `≠` are `!=`.
   */
  key: string;
  /** Whole words inside the token, folded: "Follow-up" is [follow, up]. */
  words: string[];
}

/** Lower case, accents and apostrophes removed. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "");
}

/** The whole words of a name or phrase, folded. */
export function wordsOf(s: string): string[] {
  return fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

const SYMBOL_KEYS: Record<string, string> = { "==": "=", "<>": "!=", "≠": "!=", "≥": ">=", "≤": "<=" };

/** Curly quotes read as straight ones; each is one UTF-16 unit, so offsets stay put. */
function straighten(s: string): string {
  return s.replace(/[“”„‟«»]/g, '"').replace(/[‘’‚‛]/g, "'");
}

const TOKEN = /"[^"]*"?|[<>!]=|<>|==|[≥≤≠=<>:!]|[^\s"<>=!:≥≤≠]+/gu;
const EDGE_PUNCTUATION = /^[.,;:!?()[\]{}]+|[.,;:!?()[\]{}]+$/g;

export function tokenize(typed: string): Token[] {
  const text = straighten(typed);
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const end = start + raw.length;
    if (raw.startsWith('"')) {
      const inner = raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw.slice(1);
      out.push({ kind: "quoted", text: typed.slice(start, end), start, end, key: fold(inner), words: wordsOf(inner) });
    } else if (/^[<>!=:≥≤≠]/u.test(raw)) {
      out.push({ kind: "symbol", text: typed.slice(start, end), start, end, key: SYMBOL_KEYS[raw] ?? raw, words: [] });
    } else {
      out.push({ kind: "word", text: typed.slice(start, end), start, end, key: fold(raw).replace(EDGE_PUNCTUATION, ""), words: wordsOf(raw) });
    }
  }
  return out;
}

/** The words of a run of tokens, in order. */
export function tokenWords(tokens: readonly Token[]): string[] {
  return tokens.flatMap((t) => t.words);
}

/** The words of a run of tokens with each comma between them read as `joiner`: "Lead, Won" is [lead, or, won]. */
export function tokenWordsWithCommas(tokens: readonly Token[], joiner: "or" | "and"): string[] {
  return tokens.flatMap((t, i) => (t.kind !== "quoted" && t.text.endsWith(",") && i < tokens.length - 1 ? [...t.words, joiner] : t.words));
}

/** A run of tokens as the keys the operator tables are written in. */
export function keysOf(tokens: readonly Token[]): string[] {
  return tokens.map((t) => t.key);
}

/**
 * The typed text of a run of tokens, for a value that is kept as typed. A value wrapped in double
 * quotes loses them and keeps everything inside; otherwise sentence punctuation after the last
 * word is not part of the value.
 */
export function valueText(typed: string, tokens: readonly Token[]): string {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!first || !last) return "";
  const raw = typed.slice(first.start, last.end).trim();
  if (first.kind === "quoted" && tokens.length === 1) return raw.replace(/^["“„«]/, "").replace(/["”»]$/, "");
  return raw.replace(/[\s.,;!?]+$/u, "");
}
