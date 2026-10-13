import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Share2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema } from "@/api/types";
import { Logo } from "@/components/Logo";
import { SharingDialog } from "@/components/SharingDialog";
import { UserMenu } from "@/components/UserMenu";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { choiceClass } from "@/lib/colors";
import { ROLE_LABELS, isRole } from "@/lib/roles";
import { basePermissions } from "./permissions";

export function TopBar({ schema }: { schema: BaseSchema }) {
  const [sharing, setSharing] = useState(false);
  const canEdit = basePermissions.editBase(schema.role);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-3">
      <Link to="/" aria-label="Back to all bases" className="shrink-0">
        <Logo showName={false} />
      </Link>
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold", choiceClass(schema.color))} aria-hidden>
        {schema.name.trim().charAt(0).toUpperCase() || "?"}
      </span>
      <BaseName schema={schema} editable={canEdit} />
      <div className="flex-1" />
      {isRole(schema.role) && <span className="hidden rounded-full bg-subtle px-2 py-0.5 text-xs text-muted sm:inline">{ROLE_LABELS[schema.role]}</span>}
      <Button size="sm" onClick={() => setSharing(true)}>
        <Share2 aria-hidden className="size-3.5" /> Share
      </Button>
      <IconButton label="Notifications (coming soon)" disabled aria-disabled>
        <Bell aria-hidden className="size-4" />
      </IconButton>
      <UserMenu />
      <SharingDialog open={sharing} onOpenChange={setSharing} scope={{ kind: "base", id: schema.id, name: schema.name }} myRole={schema.role} />
    </header>
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
