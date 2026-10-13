/**
 * "Import CSV" into an existing table (Editors and above): choose a file, see its first rows,
 * map each column to a field (or skip it), import. The server takes the file all-or-nothing:
 * if any row is refused nothing is written, and the problem rows are listed here.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { keys } from "@/api/keys";
import { csvApi } from "@/api/sharing";
import type { ImportResult, Table } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { autoAssign, checkAssignment, columnNames, isImportable, mappingKeys, mappingPayload } from "@/lib/csv/mapping";
import { PREVIEW_ROWS } from "@/lib/csv/read";
import { CsvFilePicker, type PickedCsv } from "./CsvFilePicker";
import { ImportProblems } from "./ImportProblems";

export interface ImportCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseId: string;
  table: Pick<Table, "id" | "name" | "fields">;
}

export function ImportCsvDialog({ open, onOpenChange, baseId, table }: ImportCsvDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl" title={`Import CSV into ${table.name}`} description="New records are added to the table. Existing records are not changed.">
      {open && <ImportBody baseId={baseId} table={table} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function ImportBody({ baseId, table, onClose }: { baseId: string; table: ImportCsvDialogProps["table"]; onClose: () => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<PickedCsv | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [assignment, setAssignment] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const rows = picked?.head.preview.rows ?? [];
  const width = picked?.head.width ?? 0;
  const names = useMemo(() => columnNames(rows[0] ?? [], width, hasHeader), [rows, width, hasHeader]);
  const sample = useMemo(() => rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + PREVIEW_ROWS), [rows, hasHeader]);
  const check = checkAssignment(assignment);
  const importable = table.fields.filter(isImportable);
  const skipped = table.fields.filter((f) => !isImportable(f));

  const start = (next: PickedCsv | null, header: boolean) => {
    setPicked(next);
    setFailure(null);
    if (next) setAssignment(autoAssign(columnNames(next.head.preview.rows[0] ?? [], next.head.width, header), table.fields));
    else setAssignment([]);
  };

  const run = async () => {
    if (!picked) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await csvApi.importIntoTable(table.id, picked.file, { hasHeader, mapping: mappingPayload(mappingKeys(names, hasHeader), assignment) });
      setResult(res);
      // New records, and perhaps new select options.
      void qc.invalidateQueries({ queryKey: ["records", table.id] });
      void qc.invalidateQueries({ queryKey: keys.base(baseId) });
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center" role="status">
        <CircleCheck aria-hidden className="size-9 text-success" />
        <h3 className="text-lg">
          Imported {result.created.toLocaleString()} record{result.created === 1 ? "" : "s"}
        </h3>
        <p className="text-[0.8125rem] text-muted">They are in {table.name} now.</p>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CsvFilePicker picked={picked} onPicked={(p) => start(p, hasHeader)} disabled={busy} />
      {picked && (
        <>
          <Checkbox
            checked={hasHeader}
            disabled={busy}
            onCheckedChange={(on) => {
              setHasHeader(on);
              start(picked, on);
            }}
            label="The first row holds the column names"
          />
          <section aria-label="Column mapping" className="flex flex-col gap-2">
            <h3 className="text-[0.9375rem]">Match columns to fields</h3>
            <p className="text-xs text-muted">
              Columns whose name matches a field are matched for you. Pick “Skip this column” to leave one out. Values are read the way pasted text is (“$1,200”, “25%”, “yes”); a select value that does not exist yet becomes a new choice.
            </p>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-max border-collapse text-left text-[0.8125rem]">
                <thead className="bg-subtle align-top">
                  <tr>
                    {names.map((name, i) => {
                      const target = assignment[i] ?? "";
                      const duplicate = !!target && check.duplicates.includes(target);
                      return (
                        <th key={i} scope="col" className="min-w-44 border-b border-line px-2 py-2 font-medium">
                          <div className="mb-1.5 truncate" title={name}>
                            {hasHeader ? name : `Column ${i + 1}`}
                          </div>
                          <Select
                            aria-label={`Field for ${hasHeader ? name : `column ${i + 1}`}`}
                            aria-invalid={duplicate || undefined}
                            disabled={busy}
                            value={target}
                            onChange={(e) => setAssignment((a) => a.map((v, k) => (k === i ? e.target.value || null : v)))}
                            className="text-[0.8125rem] font-normal"
                          >
                            <option value="">Skip this column</option>
                            {importable.map((f) => (
                              <option key={f.id} value={f.id} disabled={assignment.some((v, k) => k !== i && v === f.id)}>
                                {f.name}
                              </option>
                            ))}
                          </Select>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sample.map((r, ri) => (
                    <tr key={ri} className="border-b border-line last:border-b-0">
                      {names.map((_, ci) => (
                        <td key={ci} className="max-w-56 truncate px-2 py-1.5 text-muted" title={r[ci] ?? ""}>
                          {r[ci] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {sample.length === 0 && (
                    <tr>
                      <td colSpan={Math.max(names.length, 1)} className="px-2 py-4 text-center text-muted">
                        The file has no rows after the header.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              Showing the first {sample.length} row{sample.length === 1 ? "" : "s"}
              {picked.head.preview.more ? " of the file" : ""}.
              {skipped.length > 0 && ` ${skipped.map((f) => f.name).join(", ")} cannot be imported (computed, link, user and attachment fields are filled in other ways).`}
            </p>
            {check.duplicates.length > 0 && <Notice tone="error">A field can receive only one column. Change one of the columns that share a field.</Notice>}
            {check.mapped === 0 && check.duplicates.length === 0 && <Notice tone="warning">No column is matched to a field yet. Choose a field for at least one column.</Notice>}
          </section>
        </>
      )}
      {failure !== null && <ImportProblems error={failure} />}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {busy && <span className="mr-auto text-[0.8125rem] text-muted">Importing… large files take a moment. Keep this window open.</span>}
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={!picked || !check.ok} onClick={() => void run()}>
          {picked && check.ok ? `Import ${check.mapped} column${check.mapped === 1 ? "" : "s"}` : "Import"}
        </Button>
      </div>
    </div>
  );
}
