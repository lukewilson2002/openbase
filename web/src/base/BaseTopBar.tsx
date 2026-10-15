/**
 * The base's part of the app's top bar: its tile, the workspace above the base's name, who can open
 * it, and Share. On a phone the name truncates, fewer faces show and Share shrinks to its icon.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema } from "@/api/types";
import { EntityTile } from "@/components/icons/EntityIcon";
import { IconPicker } from "@/components/icons/IconPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { basePermissions } from "./permissions";

export function BaseTopBar({ schema, onShare }: { schema: BaseSchema; onShare: () => void }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const canEdit = basePermissions.editBase(schema.role);
  return (
    <>
      <BaseTile schema={schema} editable={canEdit} />
      <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
        {schema.workspace_name && <p className="truncate px-1.5 text-xs text-muted">{schema.workspace_name}</p>}
        <BaseName schema={schema} editable={canEdit} />
      </div>
      {/* Below 360 px the faces would leave the name no room at all; Members in the menu lists them. */}
      <Link to={`/workspace/${schema.workspace_id}/members`} className="shrink-0 rounded-full no-underline max-[359px]:hidden">
        <BaseAvatars people={schema.people} max={desktop ? 4 : 3} />
      </Link>
      <Button size="sm" onClick={onShare} aria-label="Share" className="shrink-0 max-md:size-9 max-md:px-0">
        <Share2 aria-hidden className="size-4" />
        <span aria-hidden className="max-md:hidden">
          Share
        </span>
      </Button>
    </>
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
  const tile = <EntityTile name={schema.name} icon={schema.icon} color={schema.color} size="md" />;
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
        className="h-7 max-w-64 px-1.5 font-semibold"
      />
    );
  }
  const name = rename.isPending ? value : schema.name;
  if (!editable) return <h1 className="min-w-0 truncate px-1.5 text-[0.9375rem]">{name}</h1>;
  return (
    <h1 className="min-w-0 text-[0.9375rem]">
      <button
        type="button"
        title="Rename base"
        onClick={() => {
          setValue(schema.name);
          setEditing(true);
        }}
        className="block max-w-full truncate rounded px-1.5 text-left hover:bg-hover"
      >
        {name}
      </button>
    </h1>
  );
}
