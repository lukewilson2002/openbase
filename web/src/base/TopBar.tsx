import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Share2, Zap } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema } from "@/api/types";
import { Logo } from "@/components/Logo";
import { EntityTile } from "@/components/icons/EntityIcon";
import { IconPicker } from "@/components/icons/IconPicker";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { SharingDialog } from "@/components/LazySharingDialog";
import { TrashButton } from "@/components/trash/TrashButton";
import { UserMenu } from "@/components/UserMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ROLE_LABELS, isRole } from "@/lib/roles";
import { basePermissions } from "./permissions";

export function TopBar({ schema }: { schema: BaseSchema }) {
  const [sharing, setSharing] = useState(false);
  // Mounted from the first click on (it stays, so closing still animates), loaded then.
  const [sharingLoaded, setSharingLoaded] = useState(false);
  const canEdit = basePermissions.editBase(schema.role);
  const onAutomations = useLocation().pathname.startsWith(`/base/${schema.id}/automations`);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-3">
      <Link to="/" aria-label="Back to all bases" className="shrink-0">
        <Logo showName={false} />
      </Link>
      <BaseTile schema={schema} editable={canEdit} />
      <BaseName schema={schema} editable={canEdit} />
      <div className="flex-1" />
      {isRole(schema.role) && <span className="hidden rounded-full bg-subtle px-2 py-0.5 text-xs text-muted sm:inline">{ROLE_LABELS[schema.role]}</span>}
      {basePermissions.manageAutomations(schema.role) && (
        <Button asChild size="sm" variant={onAutomations ? "primary" : "secondary"}>
          <Link to={`/base/${schema.id}/automations`} aria-label="Automations" aria-current={onAutomations ? "page" : undefined}>
            <Zap aria-hidden className="size-3.5" /> <span className="hidden sm:inline">Automations</span>
          </Link>
        </Button>
      )}
      <Button
        size="sm"
        onClick={() => {
          setSharingLoaded(true);
          setSharing(true);
        }}
      >
        <Share2 aria-hidden className="size-3.5" /> Share
      </Button>
      <TrashButton schema={schema} />
      <NotificationBell />
      <UserMenu />
      {sharingLoaded && <SharingDialog open={sharing} onOpenChange={setSharing} scope={{ kind: "base", id: schema.id, name: schema.name, icon: schema.icon }} myRole={schema.role} />}
    </header>
  );
}

/** The base's coloured tile: its icon, or its initial. Creators click it to change the icon. */
function BaseTile({ schema, editable }: { schema: BaseSchema; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const setIcon = useMutation({
    mutationFn: (icon: string | null) => api.bases.update(schema.id, { icon }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
    onError: (e) => toast.error(e, "Could not change the icon"),
  });
  const tile = <EntityTile name={schema.name} icon={schema.icon} color={schema.color} size="sm" />;
  if (!editable) return tile;
  return (
    <IconPicker value={schema.icon} onChange={(icon) => setIcon.mutate(icon)}>
      <button type="button" aria-label="Change base icon" title="Change icon" className="shrink-0 rounded hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring">
        {tile}
      </button>
    </IconPicker>
  );
}

function BaseName({ schema, editable }: { schema: BaseSchema; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(schema.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const rename = useMutation({
    mutationFn: (name: string) => api.bases.update(schema.id, { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
    onError: (e) => toast.error(e, "Could not rename base"),
  });

  const commit = () => {
    const name = value.trim();
    setEditing(false);
    if (name && name !== schema.name) rename.mutate(name);
    else setValue(schema.name);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      setValue(schema.name);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <Input
        ref={input}
        aria-label="Base name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        maxLength={255}
        className="h-7 max-w-64 font-semibold"
      />
    );
  }
  const name = rename.isPending ? value : schema.name;
  if (!editable) return <h1 className="min-w-0 truncate text-[0.9375rem]">{name}</h1>;
  return (
    <h1 className="min-w-0 text-[0.9375rem]">
      <button
        type="button"
        title="Rename base"
        onClick={() => {
          setValue(schema.name);
          setEditing(true);
        }}
        className="block max-w-full truncate rounded px-1.5 py-0.5 text-left hover:bg-hover"
      >
        {name}
      </button>
    </h1>
  );
}
