/** Choose a CSV file (button or drop), check it and read its first rows. */
import { useRef, useState, type DragEvent } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { MAX_CSV_BYTES } from "@/api/sharing";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { readCsvHead, type CsvHead } from "@/lib/csv/read";

export interface PickedCsv {
  file: File;
  head: CsvHead;
}

export interface CsvFilePickerProps {
  picked: PickedCsv | null;
  onPicked: (picked: PickedCsv | null) => void;
  disabled?: boolean;
}

export function CsvFilePicker({ picked, onPicked, disabled }: CsvFilePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setReading(true);
    const res = await readCsvHead(file);
    setReading(false);
    if (res.ok) onPicked({ file, head: res.head });
    else {
      setError(res.error);
      onPicked(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) void take(e.dataTransfer.files[0]);
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
        className="sr-only"
        aria-label="CSV file"
        disabled={disabled}
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {picked ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-subtle px-3 py-2">
          <FileSpreadsheet aria-hidden className="size-5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.8125rem] font-medium">{picked.file.name}</p>
            <p className="text-xs text-muted">{formatBytes(picked.file.size)}</p>
          </div>
          <Button size="sm" disabled={disabled} onClick={() => input.current?.click()}>
            Choose another file
          </Button>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn("flex flex-col items-center gap-2 rounded-md border border-dashed border-line-strong px-4 py-8 text-center", over && "bg-primary-soft")}
        >
          {reading ? (
            <span className="inline-flex items-center gap-2 text-[0.8125rem] text-muted">
              <Spinner className="size-4" label="Reading the file" /> Reading the file…
            </span>
          ) : (
            <>
              <Upload aria-hidden className="size-6 text-muted" />
              <Button variant="primary" disabled={disabled} onClick={() => input.current?.click()}>
                Choose a CSV file
              </Button>
              <p className="text-xs text-muted">or drop it here. Up to {formatBytes(MAX_CSV_BYTES)}, 100,000 rows and 500 columns.</p>
            </>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
