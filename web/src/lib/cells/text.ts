/**
 * Locale-free text parsing primitives (mirror of ob_core::cell::parse): numbers, durations,
 * checkbox words and comma lists. Every function is total: bad input yields `null`.
 */

const CURRENCY_SYMBOLS = new Set("$€£¥₹₩₽¢₺₫₪฿₴₦₱₡₲₵₸");

export interface ParsedNumber {
  value: number;
  percent: boolean;
}

/**
 * Parse a number from human text. Accepts thousands separators (`,`, `_`, spaces), currency
 * symbols (common ones plus `extraSymbol`), a `%`, accounting negatives `(12.50)` and
 * exponents. Commas are always thousands separators, so `1,5` reads as 15.
 */
export function parseNumber(input: string, extraSymbol?: string | null): ParsedNumber | null {
  let s = input.trim();
  if (!s || s.length > 200) return null;
  const extra = extraSymbol?.trim();
  if (extra) s = s.split(extra).join("");
  let negative = false;
  let t = s.trim();
  if (t.startsWith("(") && t.endsWith(")") && t.length >= 2) {
    negative = true;
    t = t.slice(1, -1).trim();
  }
  let percent = false;
  let cleaned = "";
  for (const c of t) {
    if (c === "%") {
      if (percent) return null;
      percent = true;
    } else if (c === "," || c === "_" || c === " " || c === " " || c === " " || c === "'") {
      continue;
    } else if (CURRENCY_SYMBOLS.has(c)) {
      continue;
    } else if (/[0-9.+\-eE]/.test(c)) {
      cleaned += c;
    } else {
      return null;
    }
  }
  if (!/[0-9]/.test(cleaned)) return null;
  // Number() accepts hex/whitespace/"Infinity"; the character filter above already ruled those out.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, percent };
}

const UNIT_TOKEN = /^\s*(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)\s*,?/i;

function parseColonDuration(s: string): number | null {
  const parts = s.split(":");
  const digits = (p: string) => /^\d+$/.test(p);
  if (parts.length === 2 && digits(parts[0]!) && digits(parts[1]!)) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    return m < 60 ? h * 3600 + m * 60 : null;
  }
  if (parts.length === 3 && digits(parts[0]!) && digits(parts[1]!)) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const sec = parts[2]!;
    if (!/^\d[\d.]*$/.test(sec) || sec.split(".").length > 2) return null;
    const secs = Number(sec);
    return m < 60 && secs < 60 ? h * 3600 + m * 60 + secs : null;
  }
  return null;
}

function parseUnitDuration(s: string): number | null {
  let rest = s;
  let total = 0;
  let any = false;
  while (rest.trim() !== "") {
    const m = UNIT_TOKEN.exec(rest);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    total += n * (unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1);
    any = true;
    rest = rest.slice(m[0].length);
  }
  return any ? total : null;
}

/**
 * Parse a duration into seconds. Accepts `h:mm`, `h:mm:ss[.fff]` (hours first), a bare number
 * of seconds, and unit forms such as `1h 30m`, `90 min`, `1.5 hours`, `45s`. A leading `-` negates.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim();
  if (!s || s.length > 100) return null;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1).trim() : s;
  let secs: number | null;
  if (body.includes(":")) secs = parseColonDuration(body);
  else if (/^\d+(\.\d+)?$|^\.\d+$/.test(body)) secs = Number(body);
  else secs = parseUnitDuration(body);
  if (secs === null || !Number.isFinite(secs)) return null;
  return negative ? -secs : secs;
}

/** Interpret a checkbox word: true, false or null when unrecognised. */
export function parseBoolWord(input: string): boolean | null {
  const s = input.trim().toLowerCase();
  if (["true", "t", "yes", "y", "checked", "check", "on", "1", "x", "✓", "✔", "☑"].includes(s)) return true;
  if (["false", "f", "no", "n", "unchecked", "off", "0", "", "☐"].includes(s)) return false;
  return null;
}

/** Split a comma-separated list, respecting double quotes. Items are trimmed; empty ones dropped. */
export function splitList(input: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quoted = false;
  let wasQuoted = false;
  const push = () => {
    const item = wasQuoted ? cur : cur.trim();
    if (item.trim() !== "") items.push(item);
    cur = "";
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"' && cur.trim() === "") {
      cur = "";
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") {
      push();
      wasQuoted = false;
    } else cur += c;
  }
  push();
  return items;
}

/** Join items with `", "`, quoting those that would not survive {@link splitList}. */
export function joinList(items: readonly string[]): string {
  return items
    .map((item) => {
      const needs = item.includes(",") || item.startsWith('"') || item.trim() !== item;
      return needs ? `"${item.replaceAll('"', '""')}"` : item;
    })
    .join(", ");
}

/** Normalise line endings and drop control characters (line breaks become spaces unless multiline). */
export function cleanText(s: string, multiline: boolean): string {
  const t = s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let out = "";
  for (const c of t) {
    if (c === "\n") out += multiline ? "\n" : " ";
    else if (c === "\t") out += "\t";
    else if (c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) < 0xa0)) continue;
    else out += c;
  }
  return out;
}

export function isValidEmail(s: string): boolean {
  if (s.length > 254 || /[\s\p{Cc}]/u.test(s)) return false;
  const at = s.lastIndexOf("@");
  if (at < 1) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || local.includes("@")) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((l) => l !== "" && !l.startsWith("-") && !l.endsWith("-") && /^[\p{L}\p{N}-]+$/u.test(l));
}

export function isValidPhone(s: string): boolean {
  if ([...s].length > 64) return false;
  const stripped = s.toLowerCase().replaceAll("extension", " ").replaceAll("ext.", " ").replaceAll("ext", " ").replaceAll("x", " ");
  const digits = (stripped.match(/[0-9]/g) ?? []).length;
  return digits >= 3 && /^[0-9 +\-().,/#*; ]*$/.test(stripped);
}

function bareUrl(s: string): string | null {
  const hostPort = s.split(/[/?#]/)[0] ?? "";
  const colon = hostPort.indexOf(":");
  const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
  const port = colon < 0 ? null : hostPort.slice(colon + 1);
  if (port !== null && !/^\d{1,5}$/.test(port)) return null;
  const hostOk = host === "localhost" || (host.includes(".") && !host.startsWith(".") && !host.endsWith(".") && !host.includes("..") && /^[\p{L}\p{N}.-]+$/u.test(host));
  return hostOk ? `https://${s}` : null;
}

/**
 * Canonical URL as the server stores it: only http, https and mailto are allowed; bare domains
 * get `https://`. Returns null when the server would reject the text.
 */
export function canonicalUrl(s: string): string | null {
  if (!s || s.length > 2048 || /[\s\p{Cc}]/u.test(s)) return null;
  if (s.startsWith("//")) return bareUrl(s.slice(2));
  const colon = s.indexOf(":");
  if (colon > 0) {
    const scheme = s.slice(0, colon);
    const rest = s.slice(colon + 1);
    if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
      const lower = scheme.toLowerCase();
      if (lower === "http" || lower === "https") {
        const host = rest.startsWith("//") ? (rest.slice(2).split(/[/?#]/)[0] ?? "") : "";
        if (!host || host.startsWith("@") || host.startsWith(":")) return null;
        return `${lower}:${rest}`;
      }
      if (lower === "mailto") return rest ? `mailto:${rest}` : null;
      const isPort = /^\d/.test(rest);
      const isHost = scheme.includes(".") || lower === "localhost";
      if (!(isPort && isHost)) return null;
    }
  }
  return bareUrl(s);
}

/** True for URLs the grid may open: http, https and mailto only. */
export function isSafeLink(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}

/** The href a cell's text opens: URLs as stored, emails as mailto:, phones as tel:. Null when unsafe. */
export function hrefFor(kind: "url" | "email" | "phone", text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (kind === "email") return isValidEmail(t) ? `mailto:${t}` : null;
  if (kind === "phone") return /^[0-9 +\-().,/#*; xXeEtn]+$/.test(t) ? `tel:${t.replace(/[^0-9+*#;,xX]/g, "")}` : null;
  return isSafeLink(t) ? t : null;
}
