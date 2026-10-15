/**
 * Form view: a builder for people who may configure the view, a live preview, an internal
 * "Fill in form" mode for editors, and the share-link dialog (creators). The form lives in
 * `ViewConfig.form`; changes go through the same debounced `PATCH /api/views/{id}` as every
 * other view setting. The public side is `src/public/PublicFormPage.tsx`.
 *
 * The toolbar is the form's own: the table and view picker, Build | Fill in form, More (open or copy
 * the public link, download CSV) and Share form. Filter, sort and "Add" have nothing to do here.
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Copy, Download, ExternalLink, Share2 } from "lucide-react";
import { keys } from "@/api/keys";
import { sharesApi } from "@/api/sharing";
import type { FormConfig } from "@/api/types";
import { useExportCsv } from "@/components/csv/ExportCsvButton";
import { EditorEnvProvider } from "@/components/record/editors/env";
import { ShareViewDialog } from "@/components/share/LazyShareViewDialog";
import { canShareView } from "@/components/share/shareView";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { ViewSwitcher } from "@/components/viewbar/ViewSwitcher";
import { toolButtonClass } from "@/components/viewbar/ViewBar";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { cleanForm, pruneForm } from "@/lib/forms/formConfig";
import { publicLink } from "@/lib/shareLinks";
import { SegmentedSwitch } from "../common/SegmentedSwitch";
import { useViewSetup } from "../common/useViewSetup";
import type { ViewProps } from "../types";
import { FormBuilder } from "./FormBuilder";
import { FormFill } from "./FormFill";

type Mode = "build" | "fill";

export default function FormView(props: ViewProps) {
  const setup = useViewSetup(props);
  const { schema, table, view, role, cfg } = setup;
  const toast = useToast();
  const canFill = atLeast(role, "editor");
  const isCreator = atLeast(role, "creator");
  const [mode, setMode] = useState<Mode>(cfg.canConfigure || !canFill ? "build" : "fill");
  const [sharing, setSharing] = useState(false);
  const csv = useExportCsv(view, setup.timeZone);
  // Only creators manage links; for everyone else the list would be refused.
  const links = useQuery({ queryKey: keys.shares(view.id), queryFn: () => sharesApi.list(view.id), enabled: isCreator && !view.personal });
  const link = links.data?.find((l) => l.enabled && l.kind === "form");
  const address = link ? publicLink(link, window.location.origin) : null;

  const setForm = useCallback(
    (next: FormConfig) => {
      cfg.update((c) => ({ ...c, form: cleanForm(pruneForm(next, table)) }));
    },
    [cfg, table],
  );

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.toast({ title: "Form link copied", variant: "success" });
    } catch (e) {
      toast.error(e, "Could not copy the link");
    }
  };

  const modes = [
    { value: "build" as const, label: cfg.canConfigure ? "Build" : "Form" },
    ...(canFill ? [{ value: "fill" as const, label: "Fill in form" }] : []),
  ];

  return (
    <EditorEnvProvider value={setup.editorEnv}>
      <div className="flex h-full min-h-[24rem] flex-col">
        <div role="toolbar" aria-label="Form toolbar" className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface px-2.5 py-2 md:px-4 md:py-2.5">
          <ViewSwitcher schema={schema} table={table} view={view} className="mr-1.5 max-w-[24rem] shrink-0 max-md:min-w-0 max-md:flex-1" />
          {modes.length > 1 ? <SegmentedSwitch label="Form mode" size="md" value={mode} options={modes} onChange={setMode} className="md:mr-1.5" /> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(toolButtonClass(), "gap-1 pr-2")}>
                More <ChevronDown aria-hidden className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {address && (
                <>
                  <DropdownMenuItem onSelect={() => window.open(address, "_blank", "noopener,noreferrer")}>
                    <ExternalLink aria-hidden className="size-4 text-muted" /> Open the form
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void copy()}>
                    <Copy aria-hidden className="size-4 text-muted" /> Copy form link
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem disabled={csv.busy} onSelect={() => void csv.run()}>
                <Download aria-hidden className="size-4 text-muted" /> {csv.busy ? "Preparing…" : "Download CSV"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="ml-auto flex items-center gap-2">
            {cfg.saving && <span className="text-xs text-muted">Saving…</span>}
            {isCreator && (
              <>
                <Button
                  variant="secondary"
                  className="h-[38px] rounded-[10px] px-3.5 font-semibold"
                  disabled={!canShareView(role, view)}
                  title={view.personal ? "Personal views cannot be shared" : "Create a public link to this form"}
                  onClick={() => setSharing(true)}
                >
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
          <div className="min-h-0 flex-1 overflow-y-auto p-4 md:py-8">
            <FormFill setup={setup} />
          </div>
        )}
      </div>
    </EditorEnvProvider>
  );
}
