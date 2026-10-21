/** Picks the editor for a field. Used by the grid's overlay (`variant="cell"`) and the expanded record (`variant="form"`). */
import { Suspense, lazy, useState } from "react";
import type { Field } from "@/api/types";
import { Spinner } from "@/components/ui/spinner";
import { displayShapeOf, isComputed } from "@/lib/cells/kinds";
import { AttachmentEditor } from "./AttachmentEditor";
import { ChoiceEditor } from "./ChoiceEditor";
import { DateEditor } from "./DateEditor";
import { FullScreenTextarea } from "./FullScreen";
import { LinkEditor } from "./LinkEditor";
import { CheckboxEditor, RatingEditor } from "./RatingEditor";
import { TextEditor } from "./TextEditor";
import { UserEditor } from "./UserEditor";
import { useAutosave } from "./useAutosave";
import { useProjectUpload } from "./useProjectUpload";
import { useEditorEnv, type FieldEditorCallbacks } from "./env";

// Tiptap and its extensions are a chunk of their own, fetched the first time a rich text field is edited.
const RichTextEditor = lazy(() => import("@/components/richtext/RichTextEditor").then((m) => ({ default: m.RichTextEditor })));

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
  /** Focus the editor when it appears (text, dates and rich text; pop-over editors open instead, see session.ts). */
  autoFocus?: boolean;
  /** No box of its own: the control sits on the page, for a field that is edited where it is shown (rating). */
  bare?: boolean;
}

/** Whether a field has an editor at all. */
export function isEditable(field: Field): boolean {
  return !isComputed(field);
}

export function FieldEditor(props: FieldEditorProps) {
  const { field, value, variant, target, initialText, onChange, onCommit, onCancel, labelledBy, autoFocus, bare } = props;
  const shape = displayShapeOf(field);
  switch (shape) {
    case "date":
      return <DateEditor field={field} value={value} initialText={initialText} variant={variant} autoFocus={autoFocus} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
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
      return <RatingEditor field={field} value={value} variant={variant} bare={bare} onCommit={onCommit} onCancel={onCancel} />;
    case "checkbox":
      return <CheckboxEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "multiline": {
      const rich = field.type === "rich_text";
      // The record form edits rich text visually; the grid's cell stays a text area (Markdown) that can open the visual editor full screen.
      if (rich && variant === "form") return <RichFormEditor field={field} value={value} autoFocus={autoFocus} onChange={onChange} onCommit={onCommit} />;
      return (
        <TextEditor
          field={field}
          value={value}
          initialText={initialText}
          variant={variant}
          autoFocus={autoFocus}
          labelledBy={labelledBy}
          renderFullScreen={({ value: text, onChange: change }) =>
            rich ? (
              <Suspense fallback={<FullScreenLoading />}>
                <RichFullScreenEditor value={text} onChange={change} label={field.name} />
              </Suspense>
            ) : (
              <FullScreenTextarea value={text} onChange={change} label={field.name} />
            )
          }
          onChange={onChange}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
    }
    default:
      return <TextEditor field={field} value={value} initialText={initialText} variant={variant} autoFocus={autoFocus} labelledBy={labelledBy} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  }
}

/** The rich text editor of a grid cell, full screen: files go to the project of the table. */
function RichFullScreenEditor({ value, onChange, label }: { value: string; onChange: (md: string) => void; label: string }) {
  const upload = useProjectUpload();
  const { collaborators } = useEditorEnv();
  return <RichTextEditor value={value} onChange={onChange} autoFocus fullScreen placeholder="Write something…" upload={upload} people={collaborators} aria-label={label} />;
}

function FullScreenLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner className="size-6" label="Loading editor" />
    </div>
  );
}

/**
 * Rich text in the expanded record: the WYSIWYG editor, saving while typing (once typing
 * pauses) and when focus leaves it, so the record's save status follows along.
 */
function RichFormEditor({ field, value, autoFocus, onChange, onCommit }: Pick<FieldEditorProps, "field" | "value" | "autoFocus" | "onChange" | "onCommit">) {
  const upload = useProjectUpload();
  const { collaborators } = useEditorEnv();
  const seed = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState(seed);
  const autosave = useAutosave(seed, (text) => onCommit({ text }));
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[8rem] items-center justify-center rounded-md border border-line-strong">
          <Spinner label="Loading editor" />
        </div>
      }
    >
      <RichTextEditor
        value={draft}
        onChange={(md) => {
          setDraft(md);
          onChange?.({ text: md });
          autosave.change(md);
        }}
        onBlur={autosave.flush}
        autoFocus={autoFocus}
        placeholder="Write something…"
        upload={upload}
        people={collaborators}
        aria-label={field.name}
      />
    </Suspense>
  );
}
