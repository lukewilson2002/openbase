/**
 * Reading the top of a CSV file in the browser, for the import preview and the column mapping.
 * The server parses the real file; this mirrors what it does closely enough that the columns the
 * person sees (and the names the mapping is keyed by) are the ones the server will find:
 *
 *   - a UTF-8 byte order mark is dropped; bytes that are not UTF-8 are read as Latin-1;
 *     UTF-16 files are refused (the server refuses them too);
 *   - the delimiter is `,`, `;` or tab, whichever is most frequent outside quotes in the first record;
 *   - quoted fields may hold the delimiter, line breaks and doubled quotes;
 *   - completely empty lines are skipped.
 */

export type Delimiter = "," | ";" | "\t";

/** `null` when the bytes are fine; otherwise why the file cannot be imported. */
export function encodingProblem(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return "This file is UTF-16. Save it as CSV UTF-8 and try again.";
  }
  return null;
}

/**
 * Decode the bytes of a CSV file. With `partial` (only the start of a larger file was read) a
 * multi-byte character cut off at the end is not taken for a sign that the file is Latin-1.
 */
export function decodeCsv(bytes: Uint8Array, partial = false): string {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body, { stream: partial });
  } catch {
    text = Array.from(body, (b) => String.fromCharCode(b)).join("");
  }
  return text.replaceAll("\0", "");
}

/** Mirrors `detect_delimiter`: counts outside quotes on the first record (first 64k characters). */
export function detectDelimiter(text: string): Delimiter {
  const counts = [0, 0, 0];
  let quoted = false;
  let seen = 0;
  for (const c of text) {
    if (++seen > 64 * 1024) break;
    if (c === '"') quoted = !quoted;
    else if ((c === "\n" || c === "\r") && !quoted) break;
    else if (!quoted) {
      if (c === ",") counts[0]!++;
      else if (c === ";") counts[1]!++;
      else if (c === "\t") counts[2]!++;
    }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (counts[i]! > counts[best]!) best = i;
  return counts[best] === 0 ? "," : ([",", ";", "\t"] as const)[best]!;
}

export interface CsvPreview {
  delimiter: Delimiter;
  /** Records in file order (header included), without empty lines; at most `maxRows`. */
  rows: string[][];
  /** The file has more records than were read. */
  more: boolean;
}

/** Parse up to `maxRows` records of `text`. */
export function parseCsvText(text: string, maxRows: number): CsvPreview {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let atFieldStart = true;
  let lineHasContent = false;
  let more = false;

  const endRow = () => {
    row.push(cell);
    // A line with nothing on it is not a record (spreadsheets show it as an empty row; the server skips it).
    if (lineHasContent || row.length > 1) rows.push(row);
    row = [];
    cell = "";
    atFieldStart = true;
    lineHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      lineHasContent = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
      atFieldStart = true;
      lineHasContent = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows) {
        more = i < text.length - 1 && text.slice(i + 1).trim() !== "";
        return { delimiter, rows, more };
      }
    } else {
      cell += c;
      atFieldStart = false;
      lineHasContent = true;
    }
  }
  if (lineHasContent || row.length > 0) endRow();
  return { delimiter, rows: rows.slice(0, maxRows), more };
}

/** Records whose cells are all blank are skipped by the server; mirror it for the preview. */
export function dropBlankRows(rows: readonly string[][]): string[][] {
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
