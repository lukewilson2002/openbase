/** Picks the editor for a field. Used by the grid's overlay (`variant="cell"`) and the expanded record (`variant="form"`). */
import { useState } from "react";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import { displayShapeOf, isComputed } from "@/lib/cells/kinds";
import { Markdown } from "../Markdown";
import { AttachmentEditor } from "./AttachmentEditor";
import { ChoiceEditor } from "./ChoiceEditor";
import { DateEditor } from "./DateEditor";
import { LinkEditor } from "./LinkEditor";
import { CheckboxEditor, RatingEditor } from "./RatingEditor";
import { TextEditor } from "./TextEditor";
import { UserEditor } from "./UserEditor";
import type { FieldEditorCallbacks } from "./env";

export interface FieldEditorProps extends FieldEditorCallbacks {
  field: Field;
  /** Current value in view form (links as `[{id,name}]`). */
  value: unknown;
  variant: "cell" | "form";
  /** Size of the grid cell, so pop-overs anchor to it (cell variant). */
  target?: { width: number; height: number };
  /** Character typed to start the edit (cell variant). */
  initialText?: string;
  labelledBy?: string;
}

/** Whether a field has an editor at all. */
export function isEditable(field: Field): boolean {
  return !isComputed(field);
}

export function FieldEditor(props: FieldEditorProps) {
  const { field, value, variant, target, initialText, onChange, onCommit, onCancel, labelledBy } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const shape = displayShapeOf(field);
  switch (shape) {
    case "date":
      return <DateEditor field={field} value={value} initialText={initialText} variant={variant} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
    case "select":
    case "multi_select":
      return <ChoiceEditor field={field} value={value} variant={variant} target={target} initialText={initialText} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
    case "link":
      return <LinkEditor field={field} value={value} variant={variant} target={target} initialText={initialText} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
    case "user":
      return <UserEditor field={field} value={value} variant={variant} target={target} initialText={initialText} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
    case "attachment":
      return <AttachmentEditor field={field} value={value} variant={variant} target={target} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
    case "rating":
      return <RatingEditor field={field} value={value} variant={variant} onCommit={onCommit} onCancel={onCancel} />;
    case "checkbox":
      return <CheckboxEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "long_text": {
      const rich = field.type === "long_text" && field.options.rich;
      const editor = (
        <TextEditor
          field={field}
          value={value}
          initialText={initialText}
          variant={variant}
          labelledBy={labelledBy}
          onChange={(e) => {
            setDraft(e.text ?? "");
            onChange?.(e);
          }}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
      if (!rich) return editor;
      return <RichTextShell draft={draft ?? (typeof value === "string" ? value : "")}>{editor}</RichTextShell>;
    }
    default:
      return <TextEditor field={field} value={value} initialText={initialText} variant={variant} labelledBy={labelledBy} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  }
}

/** Write / Preview switch for rich (markdown) long text; the editor stays mounted so its text is kept. */
function RichTextShell({ draft, children }: { draft: string; children: React.ReactNode }) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div role="tablist" aria-label="Rich text mode" className="flex gap-1 text-xs">
        {(["Write", "Preview"] as const).map((label) => {
          const on = (label === "Preview") === preview;
          return (
            <button key={label} type="button" role="tab" aria-selected={on} onClick={() => setPreview(label === "Preview")} className={cn("rounded px-2 py-0.5", on ? "bg-primary-soft text-primary" : "text-muted hover:bg-hover")}>
              {label}
            </button>
          );
        })}
        <span className="ml-auto self-center text-faint">Markdown</span>
      </div>
      <div hidden={preview}>{children}</div>
      {preview && (
        <div className="min-h-[5.5rem] rounded-md border border-line bg-surface p-2" aria-label="Markdown preview">
          {draft.trim() ? <Markdown source={draft} /> : <span className="text-faint">Nothing to preview.</span>}
        </div>
      )}
    </div>
  );
}
