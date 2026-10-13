/**
 * Form view: a builder for people who may configure the view, a live preview, an internal
 * "Fill in form" mode for editors, and the share-link dialog (creators). The form lives in
 * `ViewConfig.form`; changes go through the same debounced `PATCH /api/views/{id}` as every
 * other view setting. The public side is `src/public/PublicFormPage.tsx`.
 */
import { useCallback, useState } from "react";
import { ClipboardPen, Hammer, Share2 } from "lucide-react";
import type { FormConfig } from "@/api/types";
import { EditorEnvProvider } from "@/components/record/editors/env";
import { ShareViewDialog, canShareView } from "@/components/share/ShareViewDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { cleanForm, pruneForm } from "@/lib/forms/formConfig";
import { useViewSetup } from "../common/useViewSetup";
import type { ViewProps } from "../types";
import { FormBuilder } from "./FormBuilder";
import { FormFill } from "./FormFill";

type Mode = "build" | "fill";

function ModeTab({ mode, current, onSelect, children }: { mode: Mode; current: Mode; onSelect: (m: Mode) => void; children: React.ReactNode }) {
  const on = mode === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={() => onSelect(mode)}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium", on ? "bg-primary-soft text-primary" : "text-muted hover:bg-hover hover:text-fg")}
    >
      {children}
    </button>
  );
}

export default function FormView(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, role, cfg } = setup;
  const canFill = atLeast(role, "editor");
  const [mode, setMode] = useState<Mode>(cfg.canConfigure || !canFill ? "build" : "fill");
  const [sharing, setSharing] = useState(false);

  const setForm = useCallback(
    (next: FormConfig) => {
      cfg.update((c) => ({ ...c, form: cleanForm(pruneForm(next, table)) }));
    },
    [cfg, table],
  );

  return (
    <EditorEnvProvider value={setup.editorEnv}>
      <div className="flex h-full min-h-[24rem] flex-col">
        <div role="toolbar" aria-label="Form toolbar" className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1">
          <div role="tablist" aria-label="Form mode" className="flex gap-1">
            <ModeTab mode="build" current={mode} onSelect={setMode}>
              <Hammer aria-hidden className="size-4" /> {cfg.canConfigure ? "Build" : "Form"}
            </ModeTab>
            {canFill && (
              <ModeTab mode="fill" current={mode} onSelect={setMode}>
                <ClipboardPen aria-hidden className="size-4" /> Fill in form
              </ModeTab>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {cfg.saving && <span className="text-xs text-muted">Saving…</span>}
            {atLeast(role, "creator") && (
              <>
                <Button size="sm" variant="secondary" disabled={!canShareView(role, view)} title={view.personal ? "Personal views cannot be shared" : "Create a public link to this form"} onClick={() => setSharing(true)}>
                  <Share2 aria-hidden className="size-4" /> <span className="max-sm:sr-only">Share form</span>
                </Button>
                {sharing && <ShareViewDialog open onOpenChange={setSharing} view={view} table={table} />}
              </>
            )}
          </div>
        </div>
        {mode === "build" ? (
          <FormBuilder setup={setup} onChange={setForm} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto bg-subtle p-4">
            <FormFill setup={setup} />
          </div>
        )}
      </div>
    </EditorEnvProvider>
  );
}
