import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification, NotificationsResponse } from "@/api/types";
import { mockApi, renderWithProviders } from "@/test/utils";
import { NotificationBell, markedRead } from "./NotificationBell";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = Date.now();
const note = (id: string, kind: string, payload: unknown, read = false, ago = 60_000): Notification => ({ id, kind, payload: payload as Notification["payload"], read_at: read ? NOW : null, created_at: NOW - ago });

function listing(): NotificationsResponse {
  return {
    unread: 3,
    notifications: [
      note("n1", "mention", { base_id: "app1", table_id: "tbl1", record_id: "rec1", record_name: "Launch plan", snippet: "please review", author_name: "Grace" }),
      note("n2", "assigned", { base_id: "app1", table_id: "tbl1", record_id: "rec2", record_name: "Fix login", assigned_by: "usr3" }, false, 3 * 3600_000),
      note("n3", "automation", { message: "Weekly digest sent" }),
      note("n4", "invite", { actor_name: "Alan", base_name: "Roadmap", token: "tok1" }, true, 2 * 86400_000),
    ],
  };
}

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function renderBell() {
  return renderWithProviders(
    <>
      <NotificationBell />
      <Where />
    </>,
  );
}

describe("NotificationBell", () => {
  it("shows the unread count on the bell and lists each kind in the dropdown", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/notifications": listing() });
    renderBell();
    const bell = await screen.findByRole("button", { name: "Notifications, 3 unread" });
    expect(screen.getByTestId("notification-badge")).toHaveTextContent("3");
    await user.click(bell);
    const popup = await screen.findByRole("heading", { name: "Notifications" });
    const list = within(popup.closest("div")!.parentElement!);
    expect(list.getByText("Grace mentioned you in Launch plan")).toBeInTheDocument();
    expect(list.getByText("please review")).toBeInTheDocument();
    expect(list.getByText("You were assigned to Fix login")).toBeInTheDocument();
    expect(list.getByText("Automation notification")).toBeInTheDocument(); // payload without a name
    expect(list.getByText("Weekly digest sent")).toBeInTheDocument();
    expect(list.getByText("Alan invited you to Roadmap")).toBeInTheDocument();
    expect(list.getByText("3 hours ago")).toBeInTheDocument();
  });

  it("caps the badge and hides it when everything is read", async () => {
    mockApi({ "GET /api/notifications": { notifications: [], unread: 12 } });
    const first = renderBell();
    expect(await screen.findByTestId("notification-badge")).toHaveTextContent("9+");
    first.unmount();
    mockApi({ "GET /api/notifications": { notifications: [], unread: 0 } });
    renderBell();
    await screen.findByRole("button", { name: "Notifications" });
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });

  it("marks a notification read and opens its record when clicked", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/notifications": listing(), "POST /api/notifications/read": { ok: true } });
    renderBell();
    await user.click(await screen.findByRole("button", { name: /Notifications, 3 unread/ }));
    await user.click(await screen.findByRole("button", { name: /^Grace mentioned you in Launch plan/ }));
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")).toHaveLength(1));
    expect(api.callsTo("POST /api/notifications/read")[0]!.body).toEqual({ ids: ["n1"] });
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1?record=rec1");
  });

  it("marks one or all read without navigating", async () => {
    const user = userEvent.setup();
    // A server that remembers what was read.
    const state = listing();
    const api = mockApi({
      "GET /api/notifications": () => state,
      "POST /api/notifications/read": (call: { body: unknown }) => {
        const ids = (call.body as { ids?: string[] }).ids;
        for (const n of state.notifications) if (n.read_at == null && (!ids || ids.includes(n.id))) n.read_at = Date.now();
        state.unread = state.notifications.filter((n) => n.read_at == null).length;
        return { ok: true };
      },
    });
    renderBell();
    await user.click(await screen.findByRole("button", { name: /Notifications, 3 unread/ }));
    await user.click(await screen.findByRole("button", { name: /Mark "You were assigned to Fix login" as read/ }));
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")).toHaveLength(1));
    expect(api.callsTo("POST /api/notifications/read")[0]!.body).toEqual({ ids: ["n2"] });
    // The optimistic update drops the count straight away.
    expect(await screen.findByRole("button", { name: /Notifications, 2 unread/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Mark all read/ }));
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")).toHaveLength(2));
    expect(api.callsTo("POST /api/notifications/read")[1]!.body).toEqual({});
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("polls every 60 seconds and refetches when the window regains focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi({ "GET /api/notifications": listing() });
    renderBell();
    await screen.findByRole("button", { name: /Notifications, 3 unread/ });
    const initial = api.callsTo("GET /api/notifications").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(api.callsTo("GET /api/notifications").length).toBeGreaterThan(initial));
    const afterPoll = api.callsTo("GET /api/notifications").length;
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(api.callsTo("GET /api/notifications").length).toBeGreaterThan(afterPoll));
  });

  it("explains when notifications cannot be loaded", async () => {
    const user = userEvent.setup();
    mockApi({});
    renderBell();
    await user.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Notifications are unavailable");
  });
});

describe("markedRead", () => {
  it("marks given ids or everything and adjusts the unread count", () => {
    const data = listing();
    const one = markedRead(data, ["n1", "n4"], 5);
    expect(one.unread).toBe(2);
    expect(one.notifications.map((n) => n.read_at != null)).toEqual([true, false, false, true]);
    expect(one.notifications[3]!.read_at).toBe(NOW); // already read: untouched
    expect(markedRead(data, null, 5).unread).toBe(0);
    expect(markedRead({ ...data, unread: 0 }, ["n1"], 5).unread).toBe(0);
  });
});
