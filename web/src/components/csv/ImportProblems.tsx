/** What an import that the server refused looks like: nothing was written, here is why. */
import { ImportFailedError } from "@/api/sharing";
import { errorMessage } from "@/api/client";
import { Notice } from "@/components/layouts";

export function ImportProblems({ error }: { error: unknown }) {
  if (error instanceof ImportFailedError) {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[0.8125rem]">
        <p className="font-medium text-danger">Nothing was imported.</p>
        <p>
          {error.truncated ? `At least ${error.rows.length} rows` : `${error.rows.length} row${error.rows.length === 1 ? "" : "s"}`} could not be read. Fix {error.rows.length === 1 ? "it" : "them"} in the file and choose it again.
        </p>
        <ul aria-label="Problem rows" className="max-h-48 overflow-y-auto rounded border border-line bg-surface px-2 py-1">
          {error.rows.map((r, i) => (
            <li key={`${r.row}-${i}`} className="flex gap-2 py-0.5">
              <span className="w-16 shrink-0 font-medium tabular-nums">Row {r.row}</span>
              <span className="min-w-0 break-words">{r.message}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          Row numbers are the ones a spreadsheet shows (the header is row 1). {error.truncated ? "Only the first problems are listed; more may follow once these are fixed." : ""}
        </p>
      </div>
    );
  }
  return <Notice tone="error">{errorMessage(error)}</Notice>;
}
