import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/api/keys";
import type { TrashItem, WorkspaceSummary } from "@/api/types";
import { retentionDays, trashDaysLeft, trashItemDeleted, trashItemPlace } from "@/components/trash/trashItem";
import { useRestoreFromTrash } from "@/components/trash/useRestoreFromTrash";
import { USER, apiError, mockApi, renderApp, renderWithProviders, stubDesktop, type Handler, type RecordedCall } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const workspaces: WorkspaceSummary[] = [
  {
    id: "wsp1",
    name: "Household",
    color: "green",
    role: "owner",
    member_count: 3,
    pending_invite_count: 0,
    bases: [
      { id: "app1", workspace_id: "wsp1", name: "Chores", color: "blue", icon: "list-checks", role: "owner", people: [], tables: [] },
      { id: "app2", workspace_id: "wsp1", name: "Budget", color: "green", role: "owner", people: [], tables: [] },
    ],
  },
  {
    id: "wsp2",
    name: "Side business",
    color: "blue",
    role: "owner",
    member_count: 1,
    pending_invite_count: 0,
    bases: [{ id: "app3", workspace_id: "wsp2", name: "Clients", color: "purple", role: "owner", people: [], tables: [] }],
  },
];

const inHousehold = { workspace_id: "wsp1", workspace_name: "Household", workspace_color: "green" };
const item = (over: Partial<TrashItem> & Pick<TrashItem, "kind" | "id" | "name">): TrashItem => ({
  ...inHousehold,
  table_id: null,
  deleted_at: NOW - 2 * HOUR,
  expires_at: NOW - 2 * HOUR + 30 * DAY,
  ...over,
});

const ITEMS: TrashItem[] = [
  item({ kind: "record", id: "rec1", name: "Vacuum", base_id: "app1", base_name: "Chores", table_id: "tbl1", table_name: "Chores", deleted_by_id: "usr2", deleted_by_name: "Alex" }),
  item({ kind: "field", id: "fld1", name: "Notes", base_id: "app1", base_name: "Chores", table_id: "tbl2", table_name: "Chore log", deleted_by_id: USER.id, deleted_by_name: USER.name, deleted_at: NOW - DAY - HOUR, expires_at: NOW + 29 * DAY - HOUR }),
  item({ kind: "table", id: "tbl9", name: "Old list", base_id: "app1", base_name: "Chores", deleted_at: NOW - 3 * DAY, expires_at: NOW + 27 * DAY }),
  item({ kind: "base", id: "app9", name: "Wedding", icon: "heart", base_id: "app9", base_name: "Wedding", base_color: "pink", deleted_by_id: USER.id }),
  item({ kind: "workspace", id: "wsp9", name: "Book club", workspace_id: "wsp9", workspace_name: "Book club", workspace_color: "teal", deleted_by_id: USER.id, expires_at: NOW + 10 * DAY }),
  item({ kind: "record", id: "rec2", name: "Acme Co.", workspace_id: "wsp2", workspace_name: "Side business", base_id: "app3", base_name: "Clients", table_id: "tbl3", table_name: "Clients" }),
];

/** `GET /api/trash` that filters like the server, from a list the test can change. */
function trashRoute(list: () => TrashItem[]): Handler {
  return (call: RecordedCall) => {
    const q = call.query;
    return {
      items: list().filter(
        (i) =>
          (!q.get("workspace_id") || i.workspace_id === q.get("workspace_id")) &&
          (!q.get("base_id") || i.base_id === q.get("base_id")) &&
          (!q.get("kind") || i.kind === q.get("kind")),
      ),
    };
  };
}

function routes(extra: Record<string, Handler> = {}, items: () => TrashItem[] = () => ITEMS) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/workspaces": workspaces,
    "GET /api/trash": trashRoute(items),
    ...extra,
  });
}

const list = () => screen.findByRole("list", { name: "Deleted items" });
const row = async (name: string) => within(await list()).getByText(name).closest("li")!;
const lastQuery = (api: ReturnType<typeof mockApi>) => api.callsTo("GET /api/trash").at(-1)!.query;
/** The projects of a workspace in the menu: open for the workspace whose Trash is showing. */
const projectsOf = (workspace: string) => screen.findByRole("list", { name: `Projects in ${workspace}` });

describe("Trash page", () => {
  it("lists everything with where it was, who deleted it, when, and how long it stays", async () => {
    routes();
    renderApp({ route: "/trash" });
    expect(await screen.findByRole("heading", { level: 1, name: "Trash" })).toBeInTheDocument();
    expect(await row("Vacuum")).toHaveTextContent("VacuumRecord in Household › Chores › Chores · Deleted by Alex, 2 hours ago");
    expect(await row("Notes")).toHaveTextContent("Field in Household › Chores › Chore log · Deleted by you, yesterday");
    // Nobody recorded: no "by".
    expect(await row("Old list")).toHaveTextContent(/Table in Household › Chores · Deleted 3 days ago/);
    expect(await row("Old list")).toHaveTextContent("27 days left");
    expect(await row("Wedding")).toHaveTextContent("WeddingProject in Household · Deleted by you");
    expect(await row("Book club")).toHaveTextContent("Workspace · Deleted by you");
    expect(await row("Book club")).toHaveTextContent("10 days left");
    // Bases and workspaces show their own tiles; everything else a plain icon of its kind.
    expect((await row("Wedding")).querySelector("[data-entity-tile] svg.lucide-heart")).toBeInTheDocument();
    expect((await row("Book club")).querySelector("[data-entity-tile]")).toHaveTextContent("B");
    expect((await row("Vacuum")).querySelector("[data-entity-tile]")).toBeNull();
    expect(screen.getByText("Things stay here for 30 days, then they're removed for good.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens filtered to a workspace from its Trash link", async () => {
    stubDesktop();
    const api = routes();
    renderApp({ route: "/trash?workspace=wsp2" });
    expect(await row("Acme Co.")).toBeInTheDocument();
    expect(lastQuery(api).get("workspace_id")).toBe("wsp2");
    expect(screen.queryByText("Vacuum")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workspace: Side business" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project: All projects" })).toBeInTheDocument();
    // The menu opens that workspace, as it does for any page of one.
    expect(within(await projectsOf("Side business")).getByRole("link", { name: "Clients" })).toBeInTheDocument();
  });

  it("opens filtered to a base from the base's menu, showing the base's workspace", async () => {
    const api = routes();
    renderApp({ route: "/trash?base=app1" });
    expect(await row("Vacuum")).toBeInTheDocument();
    expect(lastQuery(api).get("base_id")).toBe("app1");
    expect(within(await list()).queryByText("Wedding")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Workspace: Household" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project: Chores" })).toBeInTheDocument();
  });

  it("filters by kind, workspace and base, and writes the filters to the URL", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    renderApp({ route: "/trash" });
    await row("Vacuum");

    await user.click(screen.getByRole("button", { name: "Records" }));
    await waitFor(() => expect(lastQuery(api).get("kind")).toBe("record"));
    expect(screen.getByRole("button", { name: "Records" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Deleted items" })).queryByText("Old list")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Workspace: All workspaces" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Household" }));
    await waitFor(() => expect(lastQuery(api).get("workspace_id")).toBe("wsp1"));
    expect(lastQuery(api).get("kind")).toBe("record");
    // The URL now says `?workspace=wsp1`: the menu opens that workspace.
    expect(within(await projectsOf("Household")).getByRole("link", { name: "Chores" })).toBeInTheDocument();

    // The base list follows the workspace.
    await user.click(screen.getByRole("button", { name: "Project: All projects" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["All projects", "Chores", "Budget"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Budget" }));
    await waitFor(() => expect(lastQuery(api).get("base_id")).toBe("app2"));
    expect(await screen.findByText("Nothing like that in the trash.")).toBeInTheDocument();

    // Another workspace clears the base.
    await user.click(screen.getByRole("button", { name: "Workspace: Household" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Side business" }));
    await waitFor(() => expect(lastQuery(api).get("workspace_id")).toBe("wsp2"));
    expect(lastQuery(api).get("base_id")).toBeNull();
    expect(await row("Acme Co.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(lastQuery(api).get("kind")).toBeNull());
  });

  it("restores an item, then lists the trash and the workspaces again", async () => {
    const user = userEvent.setup();
    let items = ITEMS;
    const api = routes(
      {
        "POST /api/trash/restore": (call) => {
          items = items.filter((i) => i.id !== (call.body as { id: string }).id);
          return { ok: true, restored_field_ids: [] };
        },
      },
      () => items,
    );
    renderApp({ route: "/trash" });
    await row("Old list");
    const workspacesBefore = api.callsTo("GET /api/workspaces").length;
    await user.click(within(await row("Old list")).getByRole("button", { name: "Restore Old list" }));
    await waitFor(() => expect(api.callsTo("POST /api/trash/restore")[0]?.body).toEqual({ kind: "table", id: "tbl9" }));
    expect(await screen.findByText("Restored Old list")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Deleted items" })).queryByText("Old list")).not.toBeInTheDocument());
    expect(api.callsTo("GET /api/workspaces").length).toBeGreaterThan(workspacesBefore);
  });

  it("restores a deleted workspace", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/trash/restore": { ok: true, restored_field_ids: [] } });
    renderApp({ route: "/trash?kind=workspace" });
    await user.click(within(await row("Book club")).getByRole("button", { name: "Restore Book club" }));
    await waitFor(() => expect(api.callsTo("POST /api/trash/restore")[0]?.body).toEqual({ kind: "workspace", id: "wsp9" }));
  });

  it("keeps the item and says so when restoring fails", async () => {
    const user = userEvent.setup();
    routes({ "POST /api/trash/restore": apiError(409, "conflict", "A table with that name exists") });
    renderApp({ route: "/trash" });
    await user.click(within(await row("Old list")).getByRole("button", { name: "Restore Old list" }));
    expect(await screen.findByText("Could not restore Old list")).toBeInTheDocument();
    expect(await row("Old list")).toBeInTheDocument();
  });

  it("says when the trash is empty, and when a filter finds nothing", async () => {
    routes({}, () => []);
    const { unmount } = renderApp({ route: "/trash" });
    expect(await screen.findByText("The trash is empty.")).toBeInTheDocument();
    expect(screen.getByText("Things stay here for 30 days, then they're removed for good.")).toBeInTheDocument();
    unmount();
    routes({}, () => []);
    renderApp({ route: "/trash?kind=field" });
    expect(await screen.findByText("Nothing like that in the trash.")).toBeInTheDocument();
  });

  it("shows an error with a way to try again", async () => {
    const user = userEvent.setup();
    let fail = true;
    routes({ "GET /api/trash": () => (fail ? apiError(500, "internal", "Disk on fire") : { items: ITEMS }) });
    renderApp({ route: "/trash" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the trash: Disk on fire");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await row("Vacuum")).toBeInTheDocument();
  });

  it("uses the server's retention for the footnote", async () => {
    routes({}, () => [item({ kind: "record", id: "r", name: "Short", deleted_at: NOW, expires_at: NOW + 7 * DAY })]);
    renderApp({ route: "/trash" });
    expect(await screen.findByText("Things stay here for 7 days, then they're removed for good.")).toBeInTheDocument();
  });
});

describe("useRestoreFromTrash", () => {
  it("reloads the base a table was restored into", async () => {
    const api = mockApi({ "GET /api/bases/app1": { id: "app1" }, "POST /api/trash/restore": { ok: true, restored_field_ids: [] } });
    let restore: ReturnType<typeof useRestoreFromTrash> | null = null;
    function Probe() {
      useQuery({ queryKey: keys.base("app1"), queryFn: () => fetch("/api/bases/app1").then((r) => r.json()) });
      restore = useRestoreFromTrash();
      return null;
    }
    renderWithProviders(<Probe />);
    await waitFor(() => expect(api.callsTo("GET /api/bases/app1")).toHaveLength(1));
    restore!.mutate(ITEMS[2]!);
    await waitFor(() => expect(api.callsTo("GET /api/bases/app1")).toHaveLength(2));
  });
});

describe("trash item text", () => {
  const record = ITEMS[0]!;
  it("names the place and who deleted it", () => {
    expect(trashItemPlace(record)).toBe("Record in Household › Chores › Chores");
    expect(trashItemPlace(ITEMS[2]!)).toBe("Table in Household › Chores");
    expect(trashItemPlace(ITEMS[3]!)).toBe("Project in Household");
    expect(trashItemPlace(ITEMS[4]!)).toBe("Workspace");
    expect(trashItemDeleted(record, "usr2", NOW)).toBe("Deleted by you, 2 hours ago");
    expect(trashItemDeleted(record, USER.id, NOW)).toBe("Deleted by Alex, 2 hours ago");
    expect(trashItemDeleted({ ...record, deleted_by_id: null, deleted_by_name: null }, USER.id, NOW)).toBe("Deleted 2 hours ago");
  });

  it("counts the days left, rounding up, and the retention", () => {
    expect(trashDaysLeft(record, NOW)).toBe("30 days left");
    expect(trashDaysLeft({ ...record, expires_at: NOW + DAY + 1 }, NOW)).toBe("2 days left");
    expect(trashDaysLeft({ ...record, expires_at: NOW + HOUR }, NOW)).toBe("1 day left");
    expect(trashDaysLeft({ ...record, expires_at: NOW - HOUR }, NOW)).toBe("Removed today");
    expect(retentionDays([])).toBe(30);
    expect(retentionDays([{ ...record, deleted_at: 0, expires_at: 14 * DAY }])).toBe(14);
  });
});
