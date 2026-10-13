/** Reading the start of a CSV `File` for the import preview. */
import { MAX_CSV_BYTES } from "@/api/sharing";
import { formatBytes } from "@/lib/format";
import { decodeCsv, dropBlankRows, encodingProblem, parseCsvText, type CsvPreview } from "./parse";

/** How much of the file is read for the preview; the server reads the whole file. */
export const PREVIEW_BYTES = 512 * 1024;
/** Rows shown in the preview (the header row not counted). */
export const PREVIEW_ROWS = 5;
/** Records scanned to find the number of columns (the preview shows only the first few). */
const SCAN_ROWS = 60;
/** More than this many columns are refused by the server. */
export const MAX_COLUMNS = 500;

export interface CsvHead {
  preview: CsvPreview;
  /** Number of columns, from the rows that were read. */
  width: number;
}

export type ReadResult = { ok: true; head: CsvHead } | { ok: false; error: string };

/** Problems that can be seen from the file's name and size alone. */
export function fileProblem(file: Pick<File, "size" | "name">): string | null {
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_CSV_BYTES) return `This file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_CSV_BYTES)}. Split it into smaller files or remove columns you do not need.`;
  return null;
}

function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

/** Read the first rows of `file`. */
export async function readCsvHead(file: File): Promise<ReadResult> {
  const problem = fileProblem(file);
  if (problem) return { ok: false, error: problem };
  let bytes: Uint8Array;
  try {
    bytes = await bytesOf(file.slice(0, PREVIEW_BYTES));
  } catch {
    return { ok: false, error: "This file could not be read." };
  }
  const encoding = encodingProblem(bytes);
  if (encoding) return { ok: false, error: encoding };
  const partial = file.size > PREVIEW_BYTES;
  const parsed = parseCsvText(decodeCsv(bytes, partial), SCAN_ROWS);
  const rows = dropBlankRows(parsed.rows);
  if (rows.length === 0) return { ok: false, error: "This file has no rows." };
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  if (width > MAX_COLUMNS) return { ok: false, error: `This file has more than ${MAX_COLUMNS} columns, which is the most one import takes.` };
  return { ok: true, head: { preview: { ...parsed, rows, more: parsed.more || partial }, width } };
}
