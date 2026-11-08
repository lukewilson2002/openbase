/**
 * Form view: a builder for people who may configure the view, a live preview, an internal
 * "Fill in form" mode for editors, and the share-link dialog (creators). The form lives in
 * `ViewConfig.form`. A public form follows the live form, so its changes are the one thing that is not a
 * draft: they save as they are made (`cfg.saveNow`). The public side is `src/public/PublicFormPage.tsx`.
 *
 * The toolbar is the form's own: Build | Fill in form, More (open or copy the public link), View options
 * (the layout tiles and Download CSV; the form builder is the form's own settings) and Share form. Filter,
 * sort and "Add" have nothing to do here.
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Copy, ExternalLink, Share2 } from "lucide-react";
import { keys } from "@/api/keys";
import { sharesApi } from "@/api/sharing";
import type { FormConfig } from "@/api/types";
import { EditorEnvProvider } from "@/components/record/editors/env";
import { ShareViewDialog } from "@/components/share/LazyShareViewDialog";
import { canShareView } from "@/components/share/shareView";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { ViewOptions } from "@/components/viewbar/ViewOptions";
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
  const { table, view, role, cfg } = setup;
  const toast = useToast();
  const canFill = atLeast(role, "editor");
  const isCreator = atLeast(role, "creator");
  const [mode, setMode] = useState<Mode>(cfg.canEditForm || !canFill ? "build" : "fill");
  const [sharing, setSharing] = useState(false);
  // Only creators manage links; for everyone else the list would be refused.
  const links = useQuery({ queryKey: keys.shares(view.id), queryFn: () => sharesApi.list(view.id), enabled: isCreator && !view.personal });
  const link = links.data?.find((l) => l.enabled && l.kind === "form");
  const address = link ? publicLink(link, window.location.origin) : null;
  // The public link follows the live form, so while it is on only a creator may change the form (the server
  // refuses an editor's save). Editors cannot list links; they ask whether one is on.
  const linkStatus = useQuery({ queryKey: keys.shareStatus(view.id), queryFn: () => sharesApi.status(view.id), enabled: canFill && !isCreator && cfg.canEditForm && !view.personal });
  const linkLocked = !isCreator && cfg.canEditForm && linkStatus.data?.enabled === true;
  const canBuild = cfg.canEditForm && !linkLocked;

  const setForm = useCallback(
    (next: FormConfig) => {
      cfg.saveNow((c) => ({ ...c, form: cleanForm(pruneForm(next, table)) }));
    },
    [cfg, table],
  );

  /** A field the form view hides is shown on the public form again. */
  const showPublic = useCallback(
    (fieldId: string) => {
      cfg.saveNow((c) => ({ ...c, hidden_fields: c.hidden_fields.filter((id) => id !== fieldId) }));
    },
    [cfg],
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

  /** The Layout section's own line for a form: the builder, which saves as it is made rather than as a draft. */
  const formSettings = (close: () => void) =>
    canBuild ? (
      mode === "build" ? (
        <p className="text-label text-muted">The form builder is open. What you change in it saves as you make it.</p>
      ) : (
        <Button
          onClick={() => {
            setMode("build");
            close();
          }}
        >
          Open the form builder
        </Button>
      )
    ) : (
      <p className="text-label text-muted">
        {linkLocked ? "This form has a public link, so only a creator can change it." : view.type !== "form" ? "Save these changes as a view to build a form from them." : "You can fill in this form but not change it."}
      </p>
    );

  const modes = [
    { value: "build" as const, label: canBuild ? "Build" : "Form" },
    ...(canFill ? [{ value: "fill" as const, label: "Fill in form" }] : []),
  ];

  return (
    <EditorEnvProvider value={setup.editorEnv}>
      <div className="flex h-full min-h-[24rem] flex-col">
        <div role="toolbar" aria-label="Form toolbar" className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface px-2.5 py-2 md:px-4 md:py-2.5">
          {modes.length > 1 ? <SegmentedSwitch label="Form mode" size="md" value={mode} options={modes} onChange={setMode} className="md:mr-1.5" /> : null}
          {address && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-1 pr-2">
                  More <ChevronDown aria-hidden className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onSelect={() => window.open(address, "_blank", "noopener,noreferrer")}>
                  <ExternalLink aria-hidden className="size-4 text-muted" /> Open the form
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copy()}>
                  <Copy aria-hidden className="size-4 text-muted" /> Copy form link
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="ml-auto flex items-center gap-2">
            {cfg.saving && <span className="text-xs text-muted">Saving…</span>}
            <ViewOptions
              schema={setup.schema}
              table={table}
              view={view}
              role={role}
              config={setup.config}
              update={cfg.update}
              collaborators={setup.people}
              layout={cfg.layout}
              onLayoutChange={cfg.setLayout}
              features={{ sort: false, group: false, color: false, properties: false, addProperty: false }}
              layoutSettings={(close) => formSettings(close)}
              timeZone={setup.timeZone}
            />
            {/* A form shown as a layout of another view is not a form someone can publish: save it as a view first. */}
            {isCreator && view.type === "form" && (
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
          <FormBuilder setup={setup} onChange={setForm} linkLocked={linkLocked} onShowPublic={showPublic} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 md:py-8">
            <FormFill setup={setup} />
          </div>
        )}
      </div>
    </EditorEnvProvider>
  );
}
