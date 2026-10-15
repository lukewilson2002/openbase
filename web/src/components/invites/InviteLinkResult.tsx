import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { CreatedInvite } from "@/api/types";
import { CopyField } from "@/components/CopyField";
import { absoluteUrl } from "@/lib/format";

/** Whether this server can send email (invites are mailed then; otherwise people share the link). */
export function useEmailEnabled(): boolean {
  const setup = useQuery({ queryKey: keys.setup, queryFn: api.setup.status, staleTime: 60_000 });
  return setup.data?.email_enabled ?? false;
}

/**
 * The link of an invite just created. It is shown once (the server only keeps its hash), so it is
 * offered even when the invite was emailed: the mail can land in spam.
 */
export function InviteLinkResult({ created, emailEnabled }: { created: CreatedInvite; emailEnabled: boolean }) {
  const email = created.info.email;
  const message = email
    ? emailEnabled
      ? `Invite sent to ${email}. You can also give them this link:`
      : `Email is not set up on this server, so send ${email} this link yourself:`
    : "Anyone with this link can join. Send it to the person you are inviting:";
  return (
    <div role="status" className="flex flex-col gap-1.5 rounded-md border border-line bg-subtle p-3">
      <p className="text-[0.8125rem]">{message}</p>
      <CopyField label="Invite link" value={absoluteUrl(created.url)} />
      <p className="text-xs text-muted">The link is shown only now.</p>
    </div>
  );
}
