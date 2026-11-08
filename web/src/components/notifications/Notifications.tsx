/**
 * Notifications: a row of the sidebar (below Home), with the unread count (polled every minute
 * and on window focus), opening the person's notifications in a popover beside it, and on a phone the
 * Notifications tab, a screen of its own (`/notifications`, PH-1). Both draw the same panel and rows.
 * Clicking a notification marks it read and goes to its record.
 */
import { useMemo, type ComponentProps } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, ClipboardList, UserCheck, Zap } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Notification, NotificationsResponse } from "@/api/types";
import { Avatar } from "@/components/ui/avatar";
import { NavRow } from "@/components/ui/nav-row";
import { LinkChip } from "@/components/ui/link-chip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import { notificationsApi } from "./api";
import { describeNotification, notificationActor, notificationActorId, notificationRecord, type NotificationKind } from "./describe";

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
 * The sidebar row. Spreads the rest of its props on the button so it can be a popover trigger;
 * `open` marks it while the panel is showing (not as the current page: the panel is not a page).
 */
export function NotificationsRow({ open, className, ...props }: { open: boolean } & Omit<ComponentProps<typeof NavRow>, "children" | "asChild" | "count" | "selected">) {
  const unread = useUnreadCount();
  return (
    <NavRow
      aria-expanded={open}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      count={unread > 0 ? <span data-testid="notifications-badge" className="font-semibold text-primary-ink">{unreadBadge(unread)}</span> : undefined}
      className={cn(open && "bg-hover", className)}
      {...props}
    >
      Notifications
    </NavRow>
  );
}

const ICONS: Record<NotificationKind, typeof Bell> = { mention: AtSign, assigned: UserCheck, automation: Zap, form_response: ClipboardList, other: Bell };

/**
 * The panel's content: "Mark all read" and the unread count, then the notifications, newest first. In a popover
 * it starts with its own heading (`headingId` names the popover); as a screen the header already says
 * "Notifications", so it starts with the toolbar. `onOpened` runs after a click took the person somewhere,
 * so the container can close.
 */
export function NotificationsPanel({ onOpened, headingId, heading = true, className }: { onOpened?: () => void; headingId?: string; heading?: boolean; className?: string }) {
  const navigate = useNavigate();
  const list = useNotifications();
  const markRead = useMarkRead();
  const unread = list.data?.unread ?? 0;
  const lookups = useLookups();

  const open = (n: Notification, href: string | null) => {
    if (n.read_at == null) markRead.mutate([n.id]);
    if (href) {
      onOpened?.();
      void navigate(href);
    }
  };

  const markAll = (
    <button
      type="button"
      disabled={unread === 0 || markRead.isPending}
      onClick={() => markRead.mutate(null)}
      className="-mr-2 flex min-h-control-md items-center rounded-md px-2 text-label font-semibold text-primary-text hover:bg-hover disabled:cursor-default disabled:text-muted disabled:opacity-60 disabled:hover:bg-transparent max-md:min-h-control-touch pointer-coarse:min-h-control-touch"
    >
      Mark all read
    </button>
  );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-1">
        {heading ? (
          <h2 id={headingId} className="text-h3">
            Notifications
          </h2>
        ) : (
          <p role="status" className="text-label text-muted">
            {list.data ? (unread > 0 ? `${unread} unread` : "All caught up") : ""}
          </p>
        )}
        {markAll}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-4" label="Loading notifications" />
          </div>
        ) : list.isError ? (
          <p role="alert" className="px-4 py-6 text-center text-label text-muted">
            Notifications are unavailable: {errorMessage(list.error)}
          </p>
        ) : list.data.notifications.length === 0 ? (
          <p className="px-6 py-8 text-center text-label text-muted">Nothing yet. Mentions, assignments and automation alerts will show up here.</p>
        ) : (
          <ul aria-label="Notifications">
            {list.data.notifications.map((n) => (
              <NotificationItem key={n.id} n={n} lookups={lookups} onOpen={open} onMarkRead={() => markRead.mutate([n.id])} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface Lookups {
  /** Emails of the people in the caller's workspaces, by user id. */
  emails: ReadonlyMap<string, string>;
  /** Collection colors, by collection id. */
  tableColors: ReadonlyMap<string, string>;
}

/**
 * What the workspaces list knows that a notification's payload does not. A face's colour comes from the
 * person's email, and notifications only carry a name, so without the emails the same person would get
 * another colour in Notifications than everywhere else. The payload names a collection but not its color.
 */
function useLookups(): Lookups {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  return useMemo(() => {
    const emails = new Map<string, string>();
    const tableColors = new Map<string, string>();
    for (const w of workspaces.data ?? [])
      for (const b of w.bases) {
        for (const p of b.people) if (p.user_id && p.email) emails.set(p.user_id, p.email);
        for (const t of b.tables) if (t.color) tableColors.set(t.id, t.color);
      }
    return { emails, tableColors };
  }, [workspaces.data]);
}

/**
 * One notification: who or what, one sentence, a chip for the record, and when. The sentence is the row's main
 * button (stretched over the whole row, so a tap anywhere opens it); the chip and the unread dot sit above it.
 */
function NotificationItem({ n, lookups, onOpen, onMarkRead }: { n: Notification; lookups: Lookups; onOpen: (n: Notification, href: string | null) => void; onMarkRead: () => void }) {
  const v = describeNotification(n);
  const Glyph = ICONS[v.kind];
  const actor = notificationActor(n);
  const actorId = notificationActorId(n);
  const isUnread = n.read_at == null;
  const record = notificationRecord(n);
  return (
    <li className="relative border-b border-line last:border-b-0 hover:bg-hover">
      <div className="flex items-start gap-3 px-4 py-3 pr-12">
        {actor && v.kind === "mention" ? (
          <span aria-hidden className="flex">
            <Avatar name={actor} email={actorId ? lookups.emails.get(actorId) : undefined} size="md" />
          </span>
        ) : (
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-pill bg-subtle text-muted">
            <Glyph className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1 text-ui">
          <button type="button" onClick={() => onOpen(n, v.href)} className={cn("text-left after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:outline-ring", isUnread ? "font-semibold" : "font-medium")}>
            {v.title}
            {isUnread && <span className="sr-only">, unread</span>}
          </button>
          {v.detail && <p className="mt-0.5 line-clamp-2 text-label text-muted">{v.detail}</p>}
          <div className="mt-1 flex min-w-0 items-center gap-2 text-meta text-muted">
            {record && (
              <LinkChip name={record.name} hue={lookups.tableColors.get(record.tableId) ?? null} markName={record.tableName ?? undefined} onOpen={() => onOpen(n, record.href)} className="relative min-w-0" />
            )}
            <time dateTime={new Date(n.created_at).toISOString()} className="shrink-0">
              {relativeTime(n.created_at)}
            </time>
          </div>
        </div>
      </div>
      {isUnread && (
        <button
          type="button"
          aria-label={`Mark "${v.title}" as read`}
          onClick={onMarkRead}
          className="absolute right-1 top-2 inline-flex size-control-md items-center justify-center rounded-md hover:bg-subtle max-md:size-control-touch pointer-coarse:size-control-touch"
        >
          <span aria-hidden className="size-2 rounded-pill bg-primary" />
        </button>
      )}
    </li>
  );
}
