/**
 * Notifications: a row of every menu (below the Inbox), with the unread count (polled every minute
 * and on window focus), opening the person's notifications beside the menu (inside the drawer on a
 * phone). Clicking a notification marks it read and goes to its record.
 */
import { useMemo, type ComponentProps } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, Mail, UserCheck, Zap } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Notification, NotificationsResponse } from "@/api/types";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import { notificationsApi } from "./api";
import { describeNotification, notificationActor, notificationActorId, notificationPlace, type NotificationKind } from "./describe";

export const NOTIFICATION_POLL_MS = 60_000;

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => api.notifications.list(),
    refetchInterval: NOTIFICATION_POLL_MS,
    refetchOnWindowFocus: "always",
    staleTime: 0,
    retry: false,
  });
}

/** How many notifications are unread (0 while loading or when they cannot be loaded). */
export function useUnreadCount(): number {
  return useNotifications().data?.unread ?? 0;
}

/** The cached response after marking `ids` (or everything) read. */
export function markedRead(data: NotificationsResponse, ids: readonly string[] | null, now: number): NotificationsResponse {
  const all = ids === null;
  const notifications = data.notifications.map((n) => (n.read_at == null && (all || ids.includes(n.id)) ? { ...n, read_at: now } : n));
  const newlyRead = data.notifications.filter((n, i) => n.read_at == null && notifications[i]!.read_at != null).length;
  return { notifications, unread: all ? 0 : Math.max(0, data.unread - newlyRead) };
}

/** Marks some (or, with null, all) notifications read, dropping the count straight away. */
function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | null) => notificationsApi.markRead(ids ?? undefined),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: keys.notifications });
      const prev = qc.getQueryData<NotificationsResponse>(keys.notifications);
      if (prev) qc.setQueryData(keys.notifications, markedRead(prev, ids, Date.now()));
      return { prev };
    },
    onError: (_e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.notifications, ctx.prev);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function unreadBadge(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

/**
 * The menu row. Spreads the rest of its props on the button so it can be a popover trigger;
 * `open` highlights it while the panel is showing.
 */
export function NotificationsRow({ open, className, ...props }: { open: boolean } & ComponentProps<"button">) {
  const unread = useUnreadCount();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      className={cn(
        "flex h-10 w-full min-w-0 items-center gap-2.5 rounded-[10px] px-3 text-left text-[0.875rem] text-fg transition-colors hover:bg-hover pointer-coarse:h-11",
        open && "bg-primary text-primary-fg hover:bg-primary-hover",
        className,
      )}
      {...props}
    >
      <Bell aria-hidden className={cn("size-[1.125rem] shrink-0", !open && "text-muted")} />
      <span className="min-w-0 flex-1 truncate">Notifications</span>
      {unread > 0 && (
        <span aria-hidden data-testid="notifications-badge" className={cn("flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold", open ? "bg-primary-fg text-primary" : "bg-primary text-primary-fg")}>
          {unreadBadge(unread)}
        </span>
      )}
    </button>
  );
}

const ICONS: Record<NotificationKind, typeof Bell> = { mention: AtSign, assigned: UserCheck, invite: Mail, automation: Zap, other: Bell };

/**
 * The panel's content: a heading with "Mark all as read", then the notifications, newest first.
 * `onOpened` runs after a click took the person somewhere, so the container can close.
 */
export function NotificationsPanel({ onOpened, headingId, className }: { onOpened?: () => void; headingId?: string; className?: string }) {
  const navigate = useNavigate();
  const list = useNotifications();
  const markRead = useMarkRead();
  const unread = list.data?.unread ?? 0;
  const emails = useKnownEmails();

  const open = (n: Notification, href: string | null) => {
    if (n.read_at == null) markRead.mutate([n.id]);
    if (href) {
      onOpened?.();
      void navigate(href);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 pb-2.5 pt-3.5">
        <h2 id={headingId} className="text-[1rem] font-semibold">
          Notifications
        </h2>
        <button
          type="button"
          disabled={unread === 0 || markRead.isPending}
          onClick={() => markRead.mutate(null)}
          className="rounded px-1 py-1 text-[0.8125rem] font-semibold text-muted hover:text-fg disabled:cursor-default disabled:opacity-50 pointer-coarse:py-2.5"
        >
          Mark all as read
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-4" label="Loading notifications" />
          </div>
        ) : list.isError ? (
          <p role="alert" className="px-4 py-6 text-center text-[0.8125rem] text-muted">
            Notifications are unavailable: {errorMessage(list.error)}
          </p>
        ) : list.data.notifications.length === 0 ? (
          <p className="px-6 py-8 text-center text-[0.8125rem] text-muted">Nothing yet. Mentions, invites and automation alerts will show up here.</p>
        ) : (
          <ul aria-label="Notifications">
            {list.data.notifications.map((n) => (
              <NotificationItem key={n.id} n={n} emails={emails} onOpen={open} onMarkRead={() => markRead.mutate([n.id])} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Emails of the people in the caller's workspaces, by user id. A face's colour comes from the
 * person's email, and notifications only carry a name, so without this the same person would get
 * another colour in Notifications than everywhere else.
 */
function useKnownEmails(): ReadonlyMap<string, string> {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const w of workspaces.data ?? []) for (const b of w.bases) for (const p of b.people) if (p.user_id && p.email) out.set(p.user_id, p.email);
    return out;
  }, [workspaces.data]);
}

function NotificationItem({ n, emails, onOpen, onMarkRead }: { n: Notification; emails: ReadonlyMap<string, string>; onOpen: (n: Notification, href: string | null) => void; onMarkRead: () => void }) {
  const v = describeNotification(n);
  const Icon = ICONS[v.kind];
  const actor = notificationActor(n);
  const actorId = notificationActorId(n);
  const isUnread = n.read_at == null;
  const place = notificationPlace(n);
  const where = [place?.base?.name, place?.table?.name].filter(Boolean).join(" › ");
  return (
    <li className="relative border-b border-line last:border-b-0">
      <button type="button" onClick={() => onOpen(n, v.href)} className="flex w-full items-start gap-3 px-4 py-3 pr-10 text-left hover:bg-hover focus-visible:bg-hover">
        {actor && (v.kind === "mention" || v.kind === "invite") ? (
          <span aria-hidden className="flex">
            <Avatar name={actor} email={actorId ? emails.get(actorId) : undefined} size="md" />
          </span>
        ) : (
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-surface">
            <Icon className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1 text-[0.875rem] leading-snug">
          <span className={cn("block", isUnread && "font-semibold")}>{v.title}</span>
          {v.detail && <span className="mt-0.5 line-clamp-2 block text-[0.8125rem] text-muted">{v.detail}</span>}
          <span className="mt-0.5 block text-xs text-faint">
            {where && `${where} · `}
            {relativeTime(n.created_at)}
          </span>
        </span>
        {isUnread && <span className="sr-only">Unread</span>}
      </button>
      {isUnread && (
        <button
          type="button"
          aria-label={`Mark "${v.title}" as read`}
          onClick={onMarkRead}
          className="absolute right-2 top-3 inline-flex size-6 items-center justify-center rounded hover:bg-hover pointer-coarse:right-0.5 pointer-coarse:top-1.5 pointer-coarse:size-10"
        >
          <span aria-hidden className="size-2 rounded-full bg-primary" />
        </button>
      )}
    </li>
  );
}
