/**
 * The bell in the top bar: unread badge (polled every minute and on window focus) and a
 * dropdown of recent notifications. Clicking one marks it read and goes to its record.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, Check, Mail, UserCheck, Zap } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Notification, NotificationsResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import { notificationsApi } from "./api";
import { EntityLabel } from "@/components/icons/EntityIcon";
import { describeNotification, notificationPlace, type NotificationKind } from "./describe";

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

const ICONS: Record<NotificationKind, typeof Bell> = { mention: AtSign, assigned: UserCheck, invite: Mail, automation: Zap, other: Bell };

/** The cached response after marking `ids` (or everything) read. */
export function markedRead(data: NotificationsResponse, ids: readonly string[] | null, now: number): NotificationsResponse {
  const all = ids === null;
  const notifications = data.notifications.map((n) => (n.read_at == null && (all || ids.includes(n.id)) ? { ...n, read_at: now } : n));
  const newlyRead = data.notifications.filter((n, i) => n.read_at == null && notifications[i]!.read_at != null).length;
  return { notifications, unread: all ? 0 : Math.max(0, data.unread - newlyRead) };
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useNotifications();
  const unread = list.data?.unread ?? 0;

  const markRead = useMutation({
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

  const openNotification = (n: Notification, href: string | null) => {
    if (n.read_at == null) markRead.mutate([n.id]);
    if (href) {
      setOpen(false);
      void navigate(href);
    }
  };

  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className="relative inline-flex size-8 shrink-0 pointer-coarse:size-10 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg">
          <Bell aria-hidden className="size-4" />
          {unread > 0 && (
            <span aria-hidden data-testid="notification-badge" className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.625rem] font-semibold leading-4 text-danger-fg">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-[0.8125rem] font-semibold">Notifications</h2>
          <Button size="sm" variant="ghost" disabled={unread === 0 || markRead.isPending} onClick={() => markRead.mutate(null)}>
            <Check aria-hidden className="size-3.5" /> Mark all read
          </Button>
        </div>
        <div className="max-h-[min(26rem,70dvh)] overflow-y-auto">
          {list.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-4" label="Loading notifications" />
            </div>
          ) : list.isError ? (
            <p role="alert" className="px-3 py-6 text-center text-[0.8125rem] text-muted">
              Notifications are unavailable: {errorMessage(list.error)}
            </p>
          ) : list.data.notifications.length === 0 ? (
            <p className="px-3 py-8 text-center text-[0.8125rem] text-muted">Nothing yet. Mentions and assignments will show up here.</p>
          ) : (
            <ul>
              {list.data.notifications.map((n) => {
                const v = describeNotification(n);
                const Icon = ICONS[v.kind];
                const isUnread = n.read_at == null;
                const place = notificationPlace(n);
                return (
                  <li key={n.id} className="group relative border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => openNotification(n, v.href)}
                      className={cn("flex w-full items-start gap-2.5 px-3 py-2.5 pr-10 text-left hover:bg-hover focus-visible:bg-hover", isUnread && "bg-primary-soft/40")}
                    >
                      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-[0.8125rem]", isUnread && "font-semibold")}>{v.title}</span>
                        {v.detail && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{v.detail}</span>}
                        {place && (
                          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted">
                            {place.base && (
                              <EntityLabel icon={place.base.icon} iconClassName="size-3.5">
                                {place.base.name}
                              </EntityLabel>
                            )}
                            {place.base && place.table && (
                              <>
                                {" "}
                                <span aria-hidden>/</span>{" "}
                              </>
                            )}
                            {place.table && (
                              <EntityLabel icon={place.table.icon} iconClassName="size-3.5">
                                {place.table.name}
                              </EntityLabel>
                            )}
                          </span>
                        )}
                        <span className="mt-0.5 block text-xs text-faint">{relativeTime(n.created_at)}</span>
                      </span>
                      {isUnread && <span className="sr-only">Unread</span>}
                    </button>
                    {isUnread && (
                      <button
                        type="button"
                        aria-label={`Mark "${v.title}" as read`}
                        onClick={() => markRead.mutate([n.id])}
                        className="absolute right-2 top-2.5 inline-flex size-6 pointer-coarse:right-0.5 pointer-coarse:top-1 pointer-coarse:size-10 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
                      >
                        <span aria-hidden className="size-2 rounded-full bg-primary" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
