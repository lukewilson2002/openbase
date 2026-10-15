import { Route, Routes, useLocation } from "react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification, NotificationsResponse } from "@/api/types";
import { IntroProvider } from "@/onboarding/IntroContext";
import { AppShell } from "@/shell/AppShell";
import { USER, mockApi, renderWithProviders, stubDesktop, type Handler } from "@/test/utils";
import { markedRead } from "./Inbox";

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

function routes(notifications: Handler, extra: Record<string, Handler> = {}) {
  return mockApi({ "GET /api/auth/me": USER, "GET /api/notifications": notifications, ...extra });
}

function renderShell() {
  return renderWithProviders(
    <IntroProvider>
      <Routes>
        <Route
          path="*"
          element={
            <AppShell sidebar={<p>Menu content</p>}>
              <Where />
            </AppShell>
          }
        />
      </Routes>
    </IntroProvider>,
  );
}

/** Opens the Inbox beside the docked menu and returns its panel. */
async function openInbox(user: ReturnType<typeof userEvent.setup>, name: RegExp | string = /^Inbox/) {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog", { name: "Inbox" });
}

describe("Inbox in the docked menu", () => {
  it("is the menu's first row, with the unread count, and lists each kind beside the menu", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes(listing());
    renderShell();
    const row = await screen.findByRole("button", { name: "Inbox, 3 unread" });
    expect(within(screen.getByRole("navigation", { name: "Main menu" })).getAllByRole("button")[0]).toBe(row);
    expect(screen.getByTestId("inbox-badge")).toHaveTextContent("3");
    expect(row).toHaveAttribute("aria-expanded", "false");
    const panel = await openInbox(user, "Inbox, 3 unread");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(within(panel).getByText("Grace mentioned you in Launch plan")).toBeInTheDocument();
    expect(within(panel).getByText("please review")).toBeInTheDocument();
    expect(within(panel).getByText("You were assigned to Fix login")).toBeInTheDocument();
    expect(within(panel).getByText("Automation notification")).toBeInTheDocument(); // payload without a name
    expect(within(panel).getByText("Weekly digest sent")).toBeInTheDocument();
    expect(within(panel).getByText("Alan invited you to Roadmap")).toBeInTheDocument();
    expect(within(panel).getByText("3 hours ago")).toBeInTheDocument();
    // The header bell is gone: the Inbox is the only way in.
    expect(screen.queryByRole("button", { name: /^Notifications/ })).not.toBeInTheDocument();
  });

  it("caps the badge and hides it when everything is read", async () => {
    stubDesktop();
    routes({ notifications: [], unread: 120 });
    const first = renderShell();
    expect(await screen.findByTestId("inbox-badge")).toHaveTextContent("99+");
    first.unmount();
    routes({ notifications: [], unread: 0 });
    renderShell();
    await screen.findByRole("button", { name: "Inbox" });
    expect(screen.queryByTestId("inbox-badge")).not.toBeInTheDocument();
  });

  it("says what will show up while there is nothing", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ notifications: [], unread: 0 });
    renderShell();
    const panel = await openInbox(user, "Inbox");
    expect(await within(panel).findByText("Nothing yet. Mentions, invites and automation alerts will show up here.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Mark all as read" })).toBeDisabled();
  });

  it("marks a notification read and opens its record when clicked, closing the inbox", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes(listing(), { "POST /api/notifications/read": { ok: true } });
    renderShell();
    const panel = await openInbox(user, /Inbox, 3 unread/);
    await user.click(within(panel).getByRole("button", { name: /^Grace mentioned you in Launch plan/ }));
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")).toHaveLength(1));
    expect(api.callsTo("POST /api/notifications/read")[0]!.body).toEqual({ ids: ["n1"] });
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1?record=rec1");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).not.toBeInTheDocument());
  });

  it("marks one or all read without navigating", async () => {
    stubDesktop();
    const user = userEvent.setup();
    // A server that remembers what was read.
    const state = listing();
    const api = routes(() => state, {
      "POST /api/notifications/read": (call: { body: unknown }) => {
        const ids = (call.body as { ids?: string[] }).ids;
        for (const n of state.notifications) if (n.read_at == null && (!ids || ids.includes(n.id))) n.read_at = Date.now();
        state.unread = state.notifications.filter((n) => n.read_at == null).length;
        return { ok: true };
      },
    });
    renderShell();
    const panel = await openInbox(user, /Inbox, 3 unread/);
    await user.click(within(panel).getByRole("button", { name: /Mark "You were assigned to Fix login" as read/ }));
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")).toHaveLength(1));
    expect(api.callsTo("POST /api/notifications/read")[0]!.body).toEqual({ ids: ["n2"] });
    // The optimistic update drops the count straight away.
    expect(await screen.findByRole("button", { name: "Inbox, 2 unread" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")).toHaveLength(2));
    expect(api.callsTo("POST /api/notifications/read")[1]!.body).toEqual({});
    expect(await screen.findByRole("button", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("names the base and table a notification is about", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({
      unread: 1,
      notifications: [note("n1", "assigned", { base_id: "app1", base_name: "Roadmap", table_id: "tbl1", table_name: "Tasks", record_id: "rec2", record_name: "Fix login", field_name: "Owner" })],
    });
    renderShell();
    const panel = await openInbox(user);
    const item = (await within(panel).findByText("You were assigned to Fix login")).closest("li")!;
    expect(item).toHaveTextContent("In Owner");
    expect(item).toHaveTextContent("Roadmap › Tasks · 1 minute ago");
  });

  it("polls every 60 seconds and refetches when the window regains focus", async () => {
    stubDesktop();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = routes(listing());
    renderShell();
    await screen.findByRole("button", { name: /Inbox, 3 unread/ });
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
    stubDesktop();
    const user = userEvent.setup();
    mockApi({ "GET /api/auth/me": USER });
    renderShell();
    const panel = await openInbox(user, "Inbox");
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Notifications are unavailable");
  });
});

describe("Inbox on a phone", () => {
  it("marks the menu button while anything is unread and opens inside the drawer", async () => {
    const user = userEvent.setup();
    routes(listing());
    renderShell();
    const toggle = await screen.findByRole("button", { name: "Show menu (3 unread in Inbox)" });
    expect(screen.getByTestId("menu-unread-dot")).toBeInTheDocument();
    await user.click(toggle);
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("button", { name: "Inbox, 3 unread" }));
    expect(within(drawer).getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(within(drawer).getByText("Grace mentioned you in Launch plan")).toBeInTheDocument();
    expect(within(drawer).queryByText("Menu content")).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "Back to the menu" }));
    expect(within(drawer).getByText("Menu content")).toBeInTheDocument();
  });

  it("has no dot when nothing is unread", async () => {
    routes({ notifications: [], unread: 0 });
    renderShell();
    expect(await screen.findByRole("button", { name: "Show menu" })).toBeInTheDocument();
    expect(screen.queryByTestId("menu-unread-dot")).not.toBeInTheDocument();
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
