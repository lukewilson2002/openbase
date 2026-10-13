import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Link2, ShieldCheck, ShieldOff, UserCheck, UserPlus, UserX } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { AdminCreatedUser, AdminUpdateUser, AdminUser, ResetLink } from "@/api/types";
import { errorMessage } from "@/api/client";
import { useMe } from "@/auth/useAuth";
import { CopyField } from "@/components/CopyField";
import { Notice } from "@/components/layouts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { absoluteUrl, formatDateTime } from "@/lib/format";

function Badge({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "good" | "bad" }) {
  const cls = tone === "good" ? "bg-success-soft text-success" : tone === "bad" ? "bg-danger-soft text-danger" : "bg-subtle text-muted";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function UsersTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useMe();
  const users = useQuery({ queryKey: keys.adminUsers, queryFn: api.admin.users });
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<{ user: AdminUser; link: ResetLink } | null>(null);
  const [confirm2fa, setConfirm2fa] = useState<AdminUser | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.adminUsers });

  const update = useMutation({
    mutationFn: (v: { id: string; body: AdminUpdateUser }) => api.admin.updateUser(v.id, v.body),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not update user"),
  });
  const reset = useMutation({
    mutationFn: (u: AdminUser) => api.admin.resetLink(u.id).then((l) => ({ user: u, link: l })),
    onSuccess: setLink,
    onError: (e) => toast.error(e, "Could not create reset link"),
  });

  if (users.isPending) return <PageSpinner label="Loading users" />;
  if (users.isError) return <Notice tone="error">{errorMessage(users.error)}</Notice>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.8125rem] text-muted">{users.data.length} user{users.data.length === 1 ? "" : "s"}</p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <UserPlus aria-hidden className="size-4" /> New user
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-[0.8125rem]">
          <thead className="border-b border-line bg-subtle text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">User</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Created</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Last login</th>
              <th scope="col" className="w-10 px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.data.map((u) => {
              const self = u.id === me?.id;
              return (
                <tr key={u.id}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.name} email={u.email} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {u.name}
                          {self && <span className="ml-1 font-normal text-muted">(you)</span>}
                        </p>
                        <p className="truncate text-xs text-muted">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {u.is_admin && <Badge tone="good">Admin</Badge>}
                      {!u.is_active && <Badge tone="bad">Deactivated</Badge>}
                      {u.totp_enabled && <Badge>2FA</Badge>}
                      {u.is_active && !u.is_admin && !u.totp_enabled && <span className="text-muted">Active</span>}
                    </div>
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-muted md:table-cell">{formatDateTime(u.created_at)}</td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-muted md:table-cell">{u.last_login_at ? formatDateTime(u.last_login_at) : "Never"}</td>
                  <td className="px-3 py-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton label={`Actions for ${u.name}`} size="sm" noTooltip>
                          <Ellipsis aria-hidden className="size-4" />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => reset.mutate(u)}>
                          <Link2 aria-hidden className="size-4" /> Create password reset link
                        </DropdownMenuItem>
                        {u.totp_enabled && (
                          <DropdownMenuItem onSelect={() => setConfirm2fa(u)}>
                            <ShieldOff aria-hidden className="size-4" /> Disable two-factor
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={self} onSelect={() => update.mutate({ id: u.id, body: { is_admin: !u.is_admin } })}>
                          <ShieldCheck aria-hidden className="size-4" /> {u.is_admin ? "Remove admin rights" : "Make administrator"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          danger={u.is_active}
                          disabled={self}
                          onSelect={() => update.mutate({ id: u.id, body: { is_active: !u.is_active } })}
                        >
                          {u.is_active ? <UserX aria-hidden className="size-4" /> : <UserCheck aria-hidden className="size-4" />}
                          {u.is_active ? "Deactivate" : "Reactivate"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onCreated={({ user, reset_link }) => {
            setCreating(false);
            void refresh();
            if (reset_link) setLink({ user, link: reset_link });
            else toast.toast({ title: "User created", variant: "success" });
          }}
        />
      )}
      {link && (
        <Dialog
          open
          onOpenChange={(o) => !o && setLink(null)}
          title={`Reset link for ${link.user.name}`}
          description="Send this link to the user so they can choose a password. It is shown once."
          footer={
            <Button variant="primary" onClick={() => setLink(null)}>
              Done
            </Button>
          }
        >
          <CopyField label="Reset link" value={absoluteUrl(link.link.url)} />
          <p className="mt-2 text-xs text-muted">Expires {formatDateTime(link.link.expires_at)}.</p>
        </Dialog>
      )}
      <ConfirmDialog
        open={!!confirm2fa}
        onOpenChange={(o) => !o && setConfirm2fa(null)}
        title={`Disable two-factor for ${confirm2fa?.name ?? "user"}?`}
        description="They will be able to log in with just their password until they set it up again. Only do this after verifying their identity."
        confirmLabel="Disable two-factor"
        destructive
        onConfirm={async () => {
          if (!confirm2fa) return;
          await api.admin.updateUser(confirm2fa.id, { disable_2fa: true });
          void refresh();
        }}
      />
    </div>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (created: AdminCreatedUser) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const create = useMutation({
    mutationFn: () => api.admin.createUser({ name: name.trim(), email: email.trim(), password: password || null, is_admin: isAdmin }),
    onSuccess: onCreated,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New user" description="Create an account directly. Leave the password empty to get a link the user can use to set their own." size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {create.isError && <Notice tone="error">{errorMessage(create.error)}</Notice>}
        <Field label="Name">{(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}</Field>
        <Field label="Email">{(ctl) => <Input {...ctl} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        <Field label="Password (optional)">
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Checkbox checked={isAdmin} onCheckedChange={setIsAdmin} label="Administrator" />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
