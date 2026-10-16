/**
 * "New table from CSV" (Creators): the server makes a table whose fields are inferred from the data
 * (the first column becomes the primary field) and imports every row, all or nothing.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { keys } from "@/api/keys";
import { csvApi } from "@/api/sharing";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { columnNames, tableNameFromFile } from "@/lib/csv/mapping";
import { PREVIEW_ROWS } from "@/lib/csv/read";
import { CsvFilePicker, type PickedCsv } from "./CsvFilePicker";
import { ImportProblems } from "./ImportProblems";

/** Into an existing base, or into a new one (the workspace page's "Import a spreadsheet"). */
export type ImportTarget =
  | { baseId: string; createBase?: undefined }
  | {
      baseId?: undefined;
      /** Makes the base when the import starts, named like the table, and answers its id. */
      createBase: (name: string) => Promise<string>;
    };

export type NewTableFromCsvDialogProps = ImportTarget & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NewTableFromCsvDialog({ open, onOpenChange, ...target }: NewTableFromCsvDialogProps) {
  const newBase = target.createBase !== undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={newBase ? "Import a spreadsheet" : "New table from CSV"}
      description={newBase ? "OpenBase makes a new base named after the file, picks a field type for each column and adds every row." : "OpenBase reads the file, picks a field type for each column and adds every row."}
    >
      {open && <Body target={target} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function Body({ target, onClose }: { target: ImportTarget; onClose: () => void }) {
  // A failed import keeps the base it made, and a retry imports into that one rather than making another.
  const [madeBase, setMadeBase] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [picked, setPicked] = useState<PickedCsv | null>(null);
  const [name, setName] = useState("");
  const [suggested, setSuggested] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const rows = picked?.head.preview.rows ?? [];
  const names = picked ? columnNames(rows[0] ?? [], picked.head.width, hasHeader) : [];
  const sample = rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + PREVIEW_ROWS);

  const onPicked = (next: PickedCsv | null) => {
    setPicked(next);
    setFailure(null);
    if (next) {
      const s = tableNameFromFile(next.file.name);
      // Keep a name the person typed; follow the file name otherwise.
      setName((cur) => (cur === "" || cur === suggested ? s : cur));
      setSuggested(s);
    }
  };

  const run = async () => {
    if (!picked) return;
    setBusy(true);
    setFailure(null);
    try {
      const trimmed = name.trim();
      let baseId = target.baseId ?? madeBase;
      if (!baseId) {
        baseId = await target.createBase!(trimmed || suggested);
        setMadeBase(baseId);
      }
      // Left as suggested, the server picks the name itself (and makes it unique among the base's tables).
      const res = await csvApi.importNewTable(baseId, picked.file, { hasHeader, ...(trimmed && trimmed !== suggested ? { name: trimmed } : {}) });
      await qc.invalidateQueries({ queryKey: keys.base(baseId) });
      toast.toast({ title: `Imported ${res.created.toLocaleString()} record${res.created === 1 ? "" : "s"}`, description: `New table with ${res.fields.length} field${res.fields.length === 1 ? "" : "s"}: ${res.fields.map((f) => f.name).slice(0, 6).join(", ")}${res.fields.length > 6 ? "…" : ""}`, variant: "success" });
      onClose();
      navigate(`/base/${baseId}/${res.table_id}`);
    } catch (e) {
      setFailure(e);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <CsvFilePicker picked={picked} onPicked={onPicked} disabled={busy} />
      {picked && (
        <>
          <Field
            label={target.createBase ? "Name" : "Table name"}
            hint={target.createBase ? "The new base and its table get this name." : "Leave it as it is to use the file name. A name that is taken gets a number."}
          >
            {(ctl) => <Input {...ctl} value={name} maxLength={255} disabled={busy} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Checkbox checked={hasHeader} disabled={busy} onCheckedChange={setHasHeader} label="The first row holds the field names" />
          <section aria-label="Preview">
            <h3 className="mb-1.5 text-[0.9375rem]">Preview</h3>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-max border-collapse text-left text-[0.8125rem]">
                <thead className="bg-subtle">
                  <tr>
                    {names.map((n, i) => (
                      <th key={i} scope="col" className="min-w-32 border-b border-line px-2 py-1.5 font-medium">
                        {hasHeader ? n : `Column ${i + 1}`}
                        {i === 0 && <span className="ml-1.5 text-xs font-normal text-muted">primary field</span>}
                      </th>
                    ))}
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
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              The first {sample.length} row{sample.length === 1 ? "" : "s"}. Field types (text, number, date, checkbox, select...) are chosen from all the values in each column; you can change them afterwards.
            </p>
          </section>
        </>
      )}
      {failure !== null && <ImportProblems error={failure} />}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {busy && <span className="mr-auto text-[0.8125rem] text-muted">Importing… large files take a moment. Keep this window open.</span>}
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={!picked || name.trim() === ""} onClick={() => void run()}>
          {target.createBase ? "Import" : "Create table"}
        </Button>
      </div>
    </div>
  );
}
