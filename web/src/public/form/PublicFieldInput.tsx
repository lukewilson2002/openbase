/**
 * One input of the public form, by field type: native, accessible controls (a visitor has no
 * account, so none of the signed-in editors). The label is a real `<label>` (or a `<legend>` for
 * groups), required fields are marked with an asterisk, and a problem is announced under the input.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { Heart, Paperclip, Star, Upload, X } from "lucide-react";
import { errorMessage } from "@/api/client";
import type { AttachmentRef, PublicFormField } from "@/api/types";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { ratingColor } from "@/lib/cells/palette";
import { choicesOfInput, controlKindOf, dateOptionsOfInput, ratingMaxOfInput, type FormInput } from "@/lib/forms/publicValues";

/** Largest file a public form accepts (`PUBLIC_UPLOAD_MAX`; the server may allow less). */
export const PUBLIC_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface PublicFieldInputProps {
  field: PublicFormField;
  value: FormInput;
  error?: string;
  disabled?: boolean;
  onChange: (value: FormInput) => void;
  /** Uploads one file for an attachment field; resolves with the stored reference. */
  upload: (file: File) => Promise<AttachmentRef>;
}

function Frame({ field, id, error, group, children }: { field: PublicFormField; id: string; error?: string; group: boolean; children: ReactNode }) {
  const label = (
    <>
      {field.label}
      {field.required && (
        <span aria-hidden className="ml-0.5 text-danger">
          *
        </span>
      )}
    </>
  );
  const help = field.help?.trim() ? (
    <p id={`${id}-help`} className="whitespace-pre-wrap text-[0.8125rem] text-muted">
      {field.help}
    </p>
  ) : null;
  const err = error ? (
    <p id={`${id}-err`} role="alert" className="text-xs text-danger">
      {error}
    </p>
  ) : null;
  return group ? (
    <fieldset className="flex min-w-0 flex-col gap-1.5" data-field-id={field.id} aria-describedby={error ? `${id}-err` : help ? `${id}-help` : undefined}>
      <legend className="mb-1.5 text-[0.875rem] font-medium">{label}</legend>
      {help}
      {children}
      {err}
    </fieldset>
  ) : (
    <div className="flex min-w-0 flex-col gap-1.5" data-field-id={field.id}>
      <label htmlFor={id} className="text-[0.875rem] font-medium">
        {label}
      </label>
      {help}
      {children}
      {err}
    </div>
  );
}

export function PublicFieldInput({ field, value, error, disabled, onChange, upload }: PublicFieldInputProps) {
  const id = useId();
  const kind = controlKindOf(field);
  const describedBy = error ? `${id}-err` : field.help?.trim() ? `${id}-help` : undefined;
  const aria = { id, "aria-invalid": error ? (true as const) : undefined, "aria-describedby": describedBy, disabled };

  switch (kind) {
    case "textarea":
      return (
        <Frame field={field} id={id} error={error} group={false}>
          <Textarea {...aria} rows={4} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
        </Frame>
      );
    case "select": {
      const choices = choicesOfInput(field);
      return (
        <Frame field={field} id={id} error={error} group={false}>
          <Select {...aria} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Frame>
      );
    }
    case "multiselect": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Frame field={field} id={id} error={error} group>
          <div className="flex flex-col gap-1">
            {choicesOfInput(field).map((c) => (
              <label key={c.id} className="flex min-h-8 items-center gap-2 text-[0.875rem]">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={chosen.includes(c.id)}
                  onChange={(e) => onChange(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
                  className="size-4 accent-[var(--primary)]"
                />
                {c.name}
              </label>
            ))}
          </div>
        </Frame>
      );
    }
    case "checkbox":
      return (
        <Frame field={field} id={id} error={error} group={false}>
          <label className="flex min-h-8 items-center gap-2 text-[0.875rem]">
            <input {...aria} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--primary)]" />
            Yes
          </label>
        </Frame>
      );
    case "rating":
      return (
        <Frame field={field} id={id} error={error} group>
          <PublicRating field={field} value={typeof value === "number" ? value : 0} disabled={disabled} onChange={onChange} />
        </Frame>
      );
    case "attachment":
      return (
        <Frame field={field} id={id} error={error} group>
          <PublicFiles field={field} files={Array.isArray(value) ? (value as AttachmentRef[]) : []} disabled={disabled} onChange={onChange} upload={upload} />
        </Frame>
      );
    case "date":
    case "datetime": {
      const opts = dateOptionsOfInput(field);
      return (
        <Frame field={field} id={id} error={error} group={false}>
          <Input {...aria} type={kind === "datetime" ? "datetime-local" : "date"} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
          {kind === "datetime" && <p className="text-xs text-muted">{opts.timezone ? `Time zone: ${opts.timezone}` : "In your time zone."}</p>}
        </Frame>
      );
    }
    default: {
      const type = kind === "email" ? "email" : kind === "url" ? "url" : kind === "tel" ? "tel" : "text";
      return (
        <Frame field={field} id={id} error={error} group={false}>
          <Input
            {...aria}
            type={type}
            inputMode={kind === "number" ? "decimal" : undefined}
            autoComplete={kind === "email" ? "email" : kind === "tel" ? "tel" : "off"}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </Frame>
      );
    }
  }
}

function PublicRating({ field, value, disabled, onChange }: { field: PublicFormField; value: number; disabled?: boolean; onChange: (v: number) => void }) {
  const max = ratingMaxOfInput(field);
  const opts = field.options as { icon?: string; color?: string } | null;
  const Icon = opts?.icon === "heart" ? Heart : Star;
  const tint = ratingColor(opts?.color ?? "yellow");
  return (
    <div role="radiogroup" aria-label={field.label} className="flex items-center gap-1">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          disabled={disabled}
          aria-checked={n === value}
          aria-label={`${n} of ${max}`}
          // Choosing the current rating again clears it.
          onClick={() => onChange(n === value ? 0 : n)}
          className="rounded p-1 hover:bg-hover"
        >
          <Icon aria-hidden className="size-6" style={{ color: tint }} fill={n <= value ? tint : "none"} />
        </button>
      ))}
    </div>
  );
}

function PublicFiles({ field, files, disabled, onChange, upload }: { field: PublicFormField; files: AttachmentRef[]; disabled?: boolean; onChange: (v: AttachmentRef[]) => void; upload: PublicFieldInputProps["upload"] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const current = useRef(files);
  current.current = files;

  const add = async (list: File[]) => {
    if (list.length === 0) return;
    setErrors([]);
    for (const file of list) {
      if (file.size > PUBLIC_UPLOAD_MAX_BYTES) {
        setErrors((e) => [...e, `${file.name} is larger than ${formatBytes(PUBLIC_UPLOAD_MAX_BYTES)}.`]);
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const ref = await upload(file);
        current.current = [...current.current, ref];
        onChange(current.current);
      } catch (e) {
        setErrors((errs) => [...errs, `${file.name}: ${errorMessage(e)}`]);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 && (
        <ul aria-label={`Files for ${field.label}`} className="flex flex-col gap-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-[0.8125rem]">
              <Paperclip aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{f.filename}</span>
              <span className="text-xs text-muted">{formatBytes(f.size)}</span>
              <button type="button" aria-label={`Remove ${f.filename}`} disabled={disabled} onClick={() => onChange(files.filter((x) => x.id !== f.id))} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                <X aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label={`Upload files for ${field.label}`}
          disabled={disabled}
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Button size="sm" disabled={disabled || busy > 0} onClick={() => inputRef.current?.click()} className={cn(busy > 0 && "opacity-80")}>
          <Upload aria-hidden className="size-4" /> {files.length > 0 ? "Add more files" : "Choose files"}
        </Button>
        {busy > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-muted">
            <Spinner className="size-3.5" label="Uploading" /> Uploading {busy} file{busy === 1 ? "" : "s"}…
          </span>
        )}
        <span className="text-xs text-muted">Up to {formatBytes(PUBLIC_UPLOAD_MAX_BYTES)} each.</span>
      </div>
      {errors.length > 0 && (
        <ul role="alert" className="text-xs text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
