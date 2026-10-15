/**
 * "Share a view" in the Share dialog: one read-only link per view, made when asked for, with an
 * optional password. It uses the same share-link API as ShareViewDialog (which still manages
 * several links per view, switching them off and deleting them); this is the short path.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Link2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import { sharesApi } from "@/api/sharing";
import type { ShareLink, View } from "@/api/types";
import { CopyField } from "@/components/CopyField";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { publicLink, sharePasswordProblem } from "@/lib/shareLinks";
import { shareKindOf } from "./shareView";

export function ShareViewTab({
  views,
  initialViewId,
  label = (v) => v.name,
  emptyText = "This table has no views that can be shared. Personal views stay private.",
}: {
  views: readonly View[];
  initialViewId?: string | null;
  /** How a view is named in the picker (from the workspace: "Chores › All chores"). */
  label?: (view: View) => string;
  emptyText?: string;
}) {
  const shareable = views.filter((v) => !v.personal);
  const [viewId, setViewId] = useState(() => (shareable.some((v) => v.id === initialViewId) ? initialViewId! : (shareable[0]?.id ?? "")));
  const view = shareable.find((v) => v.id === viewId);

  if (!view) return <p className="text-sm text-muted">{emptyText}</p>;
  const kind = shareKindOf(view);
  return (
    <div className="flex flex-col gap-[18px]">
      <Field label="View" className="gap-1.5 [&>label]:text-sm [&>label]:font-semibold">
        {(ctl) => (
          <Select {...ctl} value={viewId} onChange={(e) => setViewId(e.target.value)} className="h-11 rounded-[10px] text-base">
            {shareable.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex gap-2.5 rounded-[10px] bg-primary-soft px-3.5 py-3 text-sm leading-normal text-fg">
        <Eye aria-hidden className="mt-0.5 size-[18px] shrink-0 text-primary" />
        <p>
          {kind === "form"
            ? "Anyone with the link can fill in this form and add a record. They never see the records already in the table, and can't open the rest of the base."
            : "Anyone with the link sees only what this view shows: its records and fields, now and as they change later. They can't edit anything or open the rest of the base."}
        </p>
      </div>
      {/* Keyed by view: a half-typed password must not carry over to another view's link. */}
      <ViewLink key={view.id} view={view} />
    </div>
  );
}

function ViewLink({ view }: { view: View }) {
  const qc = useQueryClient();
  const toast = useToast();
  const kind = shareKindOf(view);
  const links = useQuery({ queryKey: keys.shares(view.id), queryFn: () => sharesApi.list(view.id) });
  const link: ShareLink | null = links.data?.find((l) => l.enabled) ?? links.data?.[0] ?? null;
  const [wantPassword, setWantPassword] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.shares(view.id) });

  const create = useMutation({
    mutationFn: () => sharesApi.create(view.id, { kind, ...(wantPassword ? { password } : {}) }),
    onSuccess: () => {
      setPassword("");
      setWantPassword(false);
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not create the link"),
  });
  const update = useMutation({
    mutationFn: (body: Parameters<typeof sharesApi.update>[1]) => sharesApi.update(link!.id, body),
    onSuccess: () => {
      setPassword("");
      setEditingPassword(false);
      setWantPassword(false);
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not change the link"),
  });

  const checkPassword = (): boolean => {
    const problem = sharePasswordProblem(password);
    setPasswordError(problem);
    return problem === null;
  };
  const passwordOn = (link?.has_password ?? false) || wantPassword;
  const typing = wantPassword || editingPassword;

  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    if (!checkPassword()) return;
    if (link) update.mutate({ password });
  };

  if (links.isPending) return <Spinner label="Loading the link" />;
  if (links.isError) return <Notice tone="error">{errorMessage(links.error)}</Notice>;

  return (
    <div className="flex flex-col gap-3">
      {!link ? (
        <div>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              if (wantPassword && !checkPassword()) return;
              create.mutate();
            }}
          >
            <Link2 aria-hidden className="size-4" /> Create link
          </Button>
        </div>
      ) : link.enabled ? (
        <CopyField value={publicLink(link, window.location.origin)} label={kind === "form" ? "Form link" : "View link"} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[0.8125rem] text-muted">The link to this view is switched off. Visitors see “not found”.</p>
          <Button size="sm" loading={update.isPending} onClick={() => update.mutate({ enabled: true })}>
            Turn the link on
          </Button>
        </div>
      )}

      <Checkbox
        checked={passwordOn}
        disabled={update.isPending}
        onCheckedChange={(on) => {
          setPasswordError(null);
          if (!on && link?.has_password) update.mutate({ password: null });
          setWantPassword(on && !link?.has_password);
          if (!on) setEditingPassword(false);
        }}
        label="Require a password"
      />
      {passwordOn && link?.has_password && !editingPassword && (
        <p className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted">
          Visitors type the password once per visit.
          <Button variant="link" size="sm" onClick={() => setEditingPassword(true)}>
            Change password
          </Button>
        </p>
      )}
      {typing && (
        <form onSubmit={savePassword} className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <Field label="Password" hint="Visitors type it once per visit. Keep it out of the link itself." error={passwordError}>
              {(ctl) => <Input {...ctl} type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={256} />}
            </Field>
          </div>
          {link && (
            <Button type="submit" className="self-start sm:mt-[1.45rem]" loading={update.isPending}>
              Save password
            </Button>
          )}
        </form>
      )}
    </div>
  );
}
