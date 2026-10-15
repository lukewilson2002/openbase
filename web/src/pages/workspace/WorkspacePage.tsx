/**
 * A workspace: its bases as cards (their tables, and who else can open each), the people who can
 * open every base, and the ways to add a base (empty or from a spreadsheet) and to share. On a
 * phone the two "add" buttons float at the bottom corners, within thumb reach.
 */
import { useState, type ComponentProps } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, FileDown, Pencil, Plus, Shapes, Share2, Table2, Trash2, Upload } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BasePerson, BaseSummary, WorkspaceSummary } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { NameDialog } from "@/components/NameDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { NewTableFromCsvDialog } from "@/components/csv/LazyCsvDialogs";
import { EntityTile } from "@/components/icons/EntityIcon";
import { IconPicker, IconPickerDialog } from "@/components/icons/IconPicker";
import { iconPatch } from "@/components/icons/iconPatch";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { workspaceColor } from "@/lib/workspaceColor";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { PendingFace, peopleLabel } from "@/shell/BaseAvatars";
import { HomeShell } from "@/shell/HomeShell";
import { WorkspaceDialogs, useUpdateWorkspace, type WorkspaceDialog } from "./WorkspaceDialogs";
import { membersLine, useWorkspace } from "./useWorkspace";

const BASE_COLOR_DEFAULT = "blue_dark";
// The header buttons are a step larger than the app's default, as on the design.
const HEADER_BUTTON = "h-10 rounded-[10px] px-3.5 text-sm font-semibold";

type BaseDialog = { kind: "create" } | { kind: "edit"; base: BaseSummary } | { kind: "icon"; base: BaseSummary } | { kind: "delete"; base: BaseSummary } | { kind: "import" } | { kind: "share" };

export function WorkspacePage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return (
    <HomeShell workspaceId={workspaceId} section="bases">
      {ws ? <Workspace key={ws.id} ws={ws} /> : fallback}
    </HomeShell>
  );
}

function Workspace({ ws }: { ws: WorkspaceSummary }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [dialog, setDialog] = useState<BaseDialog | null>(null);
  const [wsDialog, setWsDialog] = useState<WorkspaceDialog>(null);
  const [color, setColor] = useState(BASE_COLOR_DEFAULT);
  const isOwner = atLeast(ws.role, "owner");
  const canCreate = atLeast(ws.role, "creator");
  const refresh = () => qc.invalidateQueries({ queryKey: keys.workspaces });
  const close = () => setDialog(null);
  const updateWorkspace = useUpdateWorkspace();
  const tables = useBaseTables(ws.bases);
  const { everyone, only } = splitPeople(ws.bases);

  const createBase = useMutation({
    mutationFn: (v: { name: string; color?: string; icon?: string | null; empty: boolean }) =>
      api.bases.create(ws.id, { name: v.name, ...(v.color ? { color: v.color } : {}), ...(v.icon ? { icon: v.icon } : {}), empty: v.empty }),
    onSuccess: () => void refresh(),
  });
  const updateBase = useMutation({
    mutationFn: (v: { id: string; name?: string; color?: string; icon?: string | null }) => api.bases.update(v.id, { name: v.name, color: v.color, icon: v.icon }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e, "Could not update base"),
  });
  const deleteBase = useMutation({ mutationFn: (id: string) => api.bases.remove(id), onSuccess: () => void refresh() });
  const duplicateBase = useMutation({
    mutationFn: (b: BaseSummary) => api.bases.duplicate(b.id, { name: `${b.name} copy`, include_records: true }),
    onSuccess: () => {
      toast.toast({ title: "Base duplicated", variant: "success" });
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not duplicate base"),
  });

  const newBase = () => {
    setColor(BASE_COLOR_DEFAULT);
    setDialog({ kind: "create" });
  };
  const importSheet = () => setDialog({ kind: "import" });
  const share = () => setDialog({ kind: "share" });

  const tile = <EntityTile name={ws.name} icon={ws.icon} color={workspaceColor(ws)} variant="solid" size="lg" className="rounded-xl text-xl" />;
  const actions = isOwner && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`Workspace actions for ${ws.name}`} noTooltip className="md:size-10">
          <Ellipsis aria-hidden className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setWsDialog("rename")}>
          <Pencil aria-hidden className="size-4" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setWsDialog("icon")}>
          <Shapes aria-hidden className="size-4" /> Change icon…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={() => setWsDialog("delete")}>
          <Trash2 aria-hidden className="size-4" /> Delete workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 pb-32 pt-4 sm:px-6 md:px-8 md:pb-12 md:pt-8">
      <header className="mb-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-3 md:mb-6">
        <span className="hidden md:block">
          {isOwner ? (
            <IconPicker value={ws.icon} onChange={(icon) => updateWorkspace.mutate({ id: ws.id, icon })}>
              <button type="button" aria-label={`Change icon of ${ws.name}`} title="Change icon" className="block rounded-xl hover:opacity-85 focus-visible:outline-2 focus-visible:outline-ring">
                {tile}
              </button>
            </IconPicker>
          ) : (
            tile
          )}
        </span>
        <div className="min-w-0 flex-[1_1_200px]">
          <h1 className="truncate text-[1.625rem] leading-tight tracking-[-0.015em] max-md:sr-only">{ws.name}</h1>
          <WhoLine ws={ws} everyone={everyone} />
        </div>
        {/* Phones: Share and the menu stay beside the faces; adding a base is the floating buttons' job. */}
        <div className="flex shrink-0 items-center gap-2 max-md:-my-1">
          {isOwner &&
            (desktop ? (
              <Button size="lg" className={HEADER_BUTTON} onClick={share}>
                <Share2 aria-hidden className="size-4" /> Share
              </Button>
            ) : (
              <IconButton label="Share" onClick={share} noTooltip>
                <Share2 aria-hidden className="size-4" />
              </IconButton>
            ))}
          {canCreate && desktop && (
            <>
              <Button size="lg" className={HEADER_BUTTON} onClick={importSheet}>
                Import a spreadsheet
              </Button>
              <Button size="lg" variant="soft" className={cn(HEADER_BUTTON, "pl-3.5 pr-4")} onClick={newBase}>
                <Plus aria-hidden className="size-4" strokeWidth={2.2} /> New base
              </Button>
            </>
          )}
          {actions}
        </div>
      </header>

      {ws.bases.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
          <h2 className="text-[1.1875rem]">{canCreate ? "Make your first base" : "No bases here yet"}</h2>
          <p className="max-w-[420px] text-[0.9375rem] leading-relaxed text-muted">
            {canCreate ? "A base holds one project. Start empty, or bring in a spreadsheet you already have." : "When someone adds a base you can open, it shows up here."}
          </p>
          {canCreate && desktop && (
            <div className="flex flex-wrap justify-center gap-2.5">
              <Button variant="primary" size="lg" className="h-11 rounded-[10px] px-[18px] font-semibold" onClick={newBase}>
                <Plus aria-hidden className="size-4" strokeWidth={2.2} /> New base
              </Button>
              <Button size="lg" className="h-11 rounded-[10px] px-[18px] font-semibold" onClick={importSheet}>
                <Upload aria-hidden className="size-4" /> Import a spreadsheet
              </Button>
            </div>
          )}
        </div>
      ) : (
        <ul aria-label="Bases" className="grid grid-cols-1 gap-3.5 md:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
          {ws.bases.map((b) => (
            <BaseCard
              key={b.id}
              base={b}
              tables={tables.get(b.id)}
              people={only.get(b.id) ?? []}
              desktop={desktop}
              onAction={(d) => {
                if (d.kind === "edit") setColor(d.base.color);
                setDialog(d);
              }}
              onDuplicate={(b) => duplicateBase.mutate(b)}
            />
          ))}
        </ul>
      )}

      {canCreate && !desktop && (
        <>
          <FloatingButton side="left" onClick={importSheet} aria-label="Import a spreadsheet">
            <FileDown aria-hidden className="size-4" /> Import
          </FloatingButton>
          <FloatingButton side="right" soft onClick={newBase}>
            <Plus aria-hidden className="size-4" strokeWidth={2.4} /> New base
          </FloatingButton>
        </>
      )}

      <NameDialog
        open={dialog?.kind === "create" || dialog?.kind === "edit"}
        onOpenChange={(o) => !o && close()}
        title={dialog?.kind === "edit" ? "Edit base" : "New base"}
        submitLabel={dialog?.kind === "edit" ? "Save" : "Create base"}
        initialValue={dialog?.kind === "edit" ? dialog.base.name : ""}
        withIcon
        initialIcon={dialog?.kind === "edit" ? (dialog.base.icon ?? null) : null}
        extra={
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">Colour</span>
            <ColorSwatchPicker value={color} onChange={setColor} />
          </div>
        }
        onSubmit={async (name, icon) => {
          if (dialog?.kind === "edit") return updateBase.mutateAsync({ id: dialog.base.id, name, color, ...iconPatch(dialog.base.icon, icon) });
          const base = await createBase.mutateAsync({ name, color, icon, empty: true });
          await navigate(`/base/${base.id}`);
        }}
      />
      <IconPickerDialog
        open={dialog?.kind === "icon"}
        onOpenChange={(o) => !o && close()}
        title="Base icon"
        value={dialog?.kind === "icon" ? dialog.base.icon : null}
        onChange={(icon) => dialog?.kind === "icon" && updateBase.mutate({ id: dialog.base.id, icon })}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && close()}
        title={`Delete ${dialog?.kind === "delete" ? dialog.base.name : "base"}?`}
        description="The base moves to the trash and can be restored for 30 days."
        confirmLabel="Delete base"
        destructive
        onConfirm={() => (dialog?.kind === "delete" ? deleteBase.mutateAsync(dialog.base.id) : undefined)}
      />
      {dialog?.kind === "import" && (
        <NewTableFromCsvDialog
          open
          onOpenChange={(o) => !o && close()}
          createBase={async (name) => (await createBase.mutateAsync({ name, empty: true })).id}
        />
      )}
      {dialog?.kind === "share" && <ShareDialog open onOpenChange={(o) => !o && close()} scope="workspace" workspace={ws} />}
      {isOwner && <WorkspaceDialogs ws={ws} open={wsDialog} onClose={() => setWsDialog(null)} />}
    </div>
  );
}

/** The faces of who can open every base, linked to Members; without bases, just how many members. */
function WhoLine({ ws, everyone }: { ws: WorkspaceSummary; everyone: readonly BasePerson[] }) {
  const { data: me } = useMe();
  const alone = everyone.length <= 1 && ws.member_count <= 1 && ws.pending_invite_count === 0;
  const text = ws.bases.length === 0 ? membersLine(ws) : alone ? "Only you" : "Can open every base";
  const faces = ws.bases.length > 0 && everyone.length > 0;
  return (
    <Link
      to={`/workspace/${ws.id}/members`}
      aria-label={faces && !alone ? `${text} in ${ws.name}: ${peopleLabel(everyone, me?.id)}` : text}
      className="mt-1 inline-flex max-w-full items-center gap-2 text-sm text-muted no-underline hover:text-fg hover:underline max-md:mt-0 max-md:gap-2.5"
    >
      {faces && <Faces people={everyone} ring="ring-bg" size={cn(FACE_SIZES.md, "md:size-6 md:text-[0.625rem]")} />}
      <span className="truncate">{text}</span>
    </Link>
  );
}

function FloatingButton({ side, soft, className, ...props }: { side: "left" | "right"; soft?: boolean } & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-20 inline-flex h-12 items-center gap-1.5 rounded-full border pl-4 pr-[18px] text-[0.9375rem] font-semibold shadow-[0_4px_12px_rgb(15_20_30/0.12)] transition-colors",
        side === "left" ? "left-[max(1rem,env(safe-area-inset-left))]" : "right-[max(1rem,env(safe-area-inset-right))]",
        soft ? "border-primary/25 bg-primary-soft text-primary hover:bg-[color-mix(in_srgb,var(--primary)_18%,var(--surface))]" : "border-line-strong bg-surface text-fg hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

function BaseCard({
  base,
  tables,
  people,
  desktop,
  onAction,
  onDuplicate,
}: {
  base: BaseSummary;
  tables: readonly { id: string; name: string }[] | undefined;
  people: readonly BasePerson[];
  desktop: boolean;
  onAction: (d: BaseDialog) => void;
  onDuplicate: (b: BaseSummary) => void;
}) {
  const { data: me } = useMe();
  const canEdit = atLeast(base.role, "creator");
  const canDelete = atLeast(base.role, "owner");
  const label = `Also opens ${base.name}: ${peopleLabel(people, me?.id)}`;
  const faces = (size: string) => people.length > 0 && <Faces people={people} label={label} ring="ring-surface" size={size} className="relative z-10" />;
  return (
    <li className="group relative flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-4 py-3.5 transition-[box-shadow,border-color,transform] duration-150 focus-within:border-primary/40 focus-within:shadow-pop hover:border-primary/40 hover:shadow-pop motion-safe:md:hover:-translate-y-0.5 md:gap-3.5 md:p-[18px]">
      <div className="flex min-w-0 items-center gap-3">
        <EntityTile name={base.name} icon={base.icon} color={base.color} variant="tint" size="lg" className="size-9 rounded-[9px] md:size-10 md:rounded-[10px] [&_svg]:size-5 md:[&_svg]:size-[22px]" />
        <Link
          to={`/base/${base.id}`}
          className="min-w-0 flex-1 truncate text-base font-[650] text-fg no-underline after:absolute after:inset-0 after:rounded-[14px] after:content-[''] hover:text-fg"
        >
          {base.name}
        </Link>
        {!desktop && faces(FACE_SIZES.sm)}
        {(canEdit || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* Out of the way until the card is hovered or focused; always there for touch. */}
              <IconButton
                label={`Actions for ${base.name}`}
                size="sm"
                noTooltip
                className="relative z-10 -my-1 -mr-1.5 md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100 md:data-[state=open]:opacity-100 pointer-coarse:opacity-100"
              >
                <Ellipsis aria-hidden className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEdit && (
                <>
                  <DropdownMenuItem onSelect={() => onAction({ kind: "edit", base })}>
                    <Pencil aria-hidden className="size-4" /> Rename or recolour
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAction({ kind: "icon", base })}>
                    <Shapes aria-hidden className="size-4" /> Change icon…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onDuplicate(base)}>
                    <Copy aria-hidden className="size-4" /> Duplicate
                  </DropdownMenuItem>
                </>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={() => onAction({ kind: "delete", base })}>
                    <Trash2 aria-hidden className="size-4" /> Delete base
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {tables && tables.length > 0 && <TableChips base={base.name} tables={tables} max={desktop ? 3 : 2} />}
      {desktop && people.length > 0 && <div className="flex">{faces(FACE_SIZES.md)}</div>}
    </li>
  );
}

function TableChips({ base, tables, max }: { base: string; tables: readonly { id: string; name: string }[]; max: number }) {
  const shown = tables.slice(0, max);
  const rest = tables.length - shown.length;
  const chip = "inline-flex h-6 min-w-0 items-center gap-[5px] rounded-md bg-subtle px-2 text-xs font-medium text-fg/85";
  return (
    <ul aria-label={`Tables in ${base}: ${tables.map((t) => t.name).join(", ")}`} className="flex min-w-0 gap-1.5 max-md:overflow-hidden md:flex-wrap">
      {shown.map((t) => (
        <li key={t.id} className="flex min-w-0">
          <span className={chip}>
            <Table2 aria-hidden className="size-3 shrink-0 text-faint" />
            <span className="truncate">{t.name}</span>
          </span>
        </li>
      ))}
      {rest > 0 && (
        <li className="flex shrink-0">
          <span className={chip}>+{rest}</span>
        </li>
      )}
    </ul>
  );
}

const FACE_SIZES = { sm: "size-6 text-[0.625rem]", md: "size-7 text-xs" };

/** Overlapping faces, the leftmost on top. Without a `label` they are decorative (the text beside them says it). */
function Faces({ people, label, ring, size, className }: { people: readonly BasePerson[]; label?: string; ring: string; size: string; className?: string }) {
  const max = 5;
  const shown = people.length > max ? people.slice(0, max - 1) : people;
  const rest = people.length - shown.length;
  return (
    <span {...(label ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": true })} className={cn("flex shrink-0 -space-x-1.5", className)}>
      {shown.map((p, i) => (
        <span key={personKey(p, i)} aria-hidden className={cn("relative inline-flex rounded-full ring-2", ring)} style={{ zIndex: shown.length - i }}>
          {p.pending ? <PendingFace email={p.email || p.name} className={cn("border-2", size)} /> : <Avatar name={p.name} email={p.email} size="sm" className={size} />}
        </span>
      ))}
      {rest > 0 && (
        <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-subtle font-semibold text-muted ring-2", size, ring)}>
          +{rest}
        </span>
      )}
    </span>
  );
}

function personKey(p: BasePerson, fallback: number | string = ""): string {
  return p.pending ? `invite:${p.email || p.name || fallback}` : `user:${p.user_id ?? p.email}`;
}

/**
 * Who can open every base (shown once, in the header) and, per base, who can open it without being
 * one of those (shown on its card). Worked out from the bases' people because the workspace list
 * does not say who has "all bases"; a person who happens to have each base picked counts as every.
 */
export function splitPeople(bases: readonly Pick<BaseSummary, "id" | "people">[]): { everyone: BasePerson[]; only: Map<string, BasePerson[]> } {
  const only = new Map<string, BasePerson[]>();
  if (bases.length === 0) return { everyone: [], only };
  const sets = bases.map((b) => new Set(b.people.map((p) => personKey(p))));
  const everyone = bases[0]!.people.filter((p) => sets.every((s) => s.has(personKey(p))));
  const common = new Set(everyone.map((p) => personKey(p)));
  for (const b of bases) only.set(b.id, b.people.filter((p) => !common.has(personKey(p))));
  return { everyone, only };
}

/**
 * The tables of each base, for the chips on the cards. The workspace list has no tables, so they
 * come from the bases' schemas (the same queries the base page uses, so opening a base is instant).
 */
function useBaseTables(bases: readonly BaseSummary[]): Map<string, { id: string; name: string }[]> {
  const schemas = useQueries({
    queries: bases.map((b) => ({ queryKey: keys.base(b.id), queryFn: () => api.bases.get(b.id), retry: false })),
  });
  const out = new Map<string, { id: string; name: string }[]>();
  bases.forEach((b, i) => {
    const tables = schemas[i]?.data?.tables;
    if (tables) out.set(b.id, tables);
  });
  return out;
}
