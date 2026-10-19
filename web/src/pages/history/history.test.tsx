import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, ActivityPage, Field, Member, WorkspaceSummary } from "@/api/types";
import { CHOICES, field } from "@/test/fields";
import { USER, mockApi, renderApp, stubDesktop, type Handler, type RecordedCall } from "@/test/utils";
import { dayKey, dayLabel, groupActivity, sectionByDay } from "./activity";

// Sunday 18 October 2026, 4:00 PM in the person's zone (UTC here).
const NOW = Date.UTC(2026, 9, 18, 16, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: NOW }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ME = { ...USER, timezone: "UTC" };

const workspaces: WorkspaceSummary[] = [
  {
    id: "wsp1",
    name: "Acme",
    color: "green",
    role: "owner",
    member_count: 2,
    pending_invite_count: 0,
    bases: [
      { id: "app1", workspace_id: "wsp1", name: "CRM", color: "blue", icon: "briefcase", role: "owner", people: [], tables: [] },
      { id: "app2", workspace_id: "wsp1", name: "Ops", color: "purple", role: "owner", people: [], tables: [] },
    ],
  },
  { id: "wsp2", name: "Home", color: "teal", role: "owner", member_count: 1, pending_invite_count: 0, bases: [{ id: "app3", workspace_id: "wsp2", name: "Chores", color: "pink", role: "owner", people: [], tables: [] }] },
];

const member = (user_id: string, name: string): Member => ({ user_id, name, email: `${name.split(" ")[0]!.toLowerCase()}@example.com`, role: "editor", all_bases: true, base_ids: [] });
const MEMBERS: Record<string, Member[]> = {
  wsp1: [member("usr1", "Ada Lovelace"), member("usr2", "Grace Hopper")],
  wsp2: [member("usr1", "Ada Lovelace"), member("usr3", "Alan Turing")],
};

const STATUS: Field = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const NOTES: Field = field("long_text", { rich: false }, { id: "fld_notes", name: "Notes" });
const DUE: Field = field("single_line_text", {}, { id: "fld_due", name: "Due" });
const OWNER: Field = field("single_line_text", {}, { id: "fld_owner", name: "Owner" });
const FIELDS = Object.fromEntries([STATUS, NOTES, DUE, OWNER].map((f) => [f.id, f]));

const ADA = { id: "usr1", name: "Ada Lovelace" };
const GRACE = { id: "usr2", name: "Grace Hopper" };
const crm = { workspace_id: "wsp1", workspace_name: "Acme", workspace_color: "green", base_id: "app1", base_name: "CRM", base_icon: "briefcase", base_color: "blue", table_id: "tbl1", table_name: "Deals" };
const ops = { ...crm, base_id: "app2", base_name: "Ops", base_color: "purple", table_id: "tbl2", table_name: "Sprints" };

const item = (id: string, kind: string, ago: number, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind,
  created_at: NOW - ago,
  author: ADA,
  record: { id: "rec1", name: "Big deal", deleted: false },
  place: crm,
  changes: {},
  comment: null,
  ...over,
});

const LONG = "Call them about the renewal, then send the quote and ask about the board meeting. ".repeat(4).trim();

const PAGE_1: ActivityItem[] = [
  item("c1", "comment", 5 * MIN, { author: GRACE, comment: "Sent the quote, thanks @[Ada Lovelace](usr1)" }),
  item("h5", "update", 18 * MIN, { changes: { fld_status: { old: "chs1", new: "chs3" } } }),
  item("h4", "update", 2 * HOUR, {
    changes: { fld_status: { old: "chs3", new: "chs2" }, fld_due: { old: "Fri", new: "Mon" }, fld_notes: { old: null, new: LONG }, fld_owner: { old: "Ada", new: null } },
  }),
  item("h3", "create", 3 * HOUR, { author: GRACE, record: { id: "rec2", name: "Sprint 1", deleted: false }, place: ops, changes: { fld_status: { old: null, new: "chs1" } } }),
  item("h2", "update", 4 * HOUR, { changes: { fld_due: { old: "Mon", new: "Tue" } } }),
  item("h1", "delete", DAY + 2 * HOUR, { author: null, record: { id: "rec3", name: "Old plan", deleted: true }, place: ops }),
];
const PAGE_2: ActivityItem[] = [item("h0", "update", 3 * DAY, { record: { id: "rec2", name: "Sprint 1", deleted: false }, place: ops, changes: { fld_due: { old: "Tue", new: "Wed" } } })];

/** `GET /api/history` that pages: page 1 hands out the cursor "p2". */
function feedRoute(page1: ActivityItem[] = PAGE_1, page2: ActivityItem[] = PAGE_2): Handler {
  return (call: RecordedCall): ActivityPage => {
    const items = call.query.get("before") === "p2" ? page2 : page1;
    return { items, next: call.query.get("before") === "p2" || page2.length === 0 ? null : "p2", fields: FIELDS };
  };
}

function routes(extra: Record<string, Handler> = {}, feed: Handler = feedRoute()) {
  return mockApi({
    "GET /api/auth/me": ME,
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/workspaces": workspaces,
    "GET /api/workspaces/wsp1/members": MEMBERS.wsp1!,
    "GET /api/workspaces/wsp2/members": MEMBERS.wsp2!,
    "GET /api/history": feed,
    ...extra,
  });
}

const lastQuery = (api: ReturnType<typeof mockApi>) => api.callsTo("GET /api/history").at(-1)!.query;
const card = (name: string, nth = 0) => screen.getAllByRole("article", { name: `Activity on ${name}` })[nth]!;

describe("History page", () => {
  it("groups consecutive activity on a record into one card, by day", async () => {
    routes();
    renderApp({ route: "/history" });
    expect(await screen.findByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
    await screen.findAllByRole("article");
    // The comment, the 18-minute-old change and the 2-hour-old one share a card; Sprint 1 breaks the run.
    const cards = screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"));
    expect(cards).toEqual(["Activity on Big deal", "Activity on Sprint 1", "Activity on Big deal", "Activity on Old plan"]);
    expect(within(card("Big deal", 0)).getByRole("list", { name: "Activity on Big deal" }).children).toHaveLength(3);
    expect(within(card("Big deal", 1)).getByRole("list", { name: "Activity on Big deal" }).children).toHaveLength(1);
    // Days: today and yesterday.
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Today", "Yesterday"]);
    expect(screen.getByRole("region", { name: "Yesterday" })).toContainElement(card("Old plan"));
  });

  it("says where each record is, with the record opening expanded", async () => {
    routes();
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    const deal = card("Big deal", 0);
    expect(deal).toHaveTextContent(/Big deal.*Acme.*›.*CRM.*›.*Deals/);
    expect(within(deal).getByRole("link", { name: "Big deal" })).toHaveAttribute("href", "/base/app1/tbl1?record=rec1");
    expect(card("Sprint 1", 0)).toHaveTextContent(/Acme.*›.*Ops.*›.*Sprints/);
    expect(within(card("Sprint 1", 0)).getByRole("link", { name: "Sprint 1" })).toHaveAttribute("href", "/base/app2/tbl2?record=rec2");
    // A tile for the workspace and one for the project, like the Trash page.
    expect(deal.querySelectorAll("[data-entity-tile]")).toHaveLength(2);
    // A deleted record is struck through and cannot be opened.
    const gone = card("Old plan");
    expect(gone).toHaveTextContent("Old plan (deleted)");
    expect(within(gone).queryByRole("link")).toBeNull();
    expect(gone.querySelector(".line-through")).toHaveTextContent("Old plan");
  });

  it("tells in words what happened, with values as the record shows them", async () => {
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    const rows = within(card("Big deal", 0)).getAllByRole("listitem");
    const comment = rows.find((r) => r.textContent?.includes("commented"))!;
    expect(comment).toHaveTextContent("Grace Hopper commented");
    // Mentions read as @Name.
    expect(comment).toHaveTextContent("Sent the quote, thanks @Ada Lovelace");
    const single = rows.find((r) => r.textContent?.includes("Ada Lovelace changed Status"))!;
    expect(single).toHaveTextContent("Ada Lovelace changed Status from Todo to Done");
    const several = rows.find((r) => r.textContent?.includes("made 4 changes"))!;
    expect(several).toHaveTextContent("changed Status from Done to In progress");
    expect(several).toHaveTextContent("changed Due from Fri to Mon");
    expect(several).toHaveTextContent("set Notes to Call them");
    // The fourth change is behind a button.
    expect(several).not.toHaveTextContent("cleared Owner");
    await user.click(within(several).getByRole("button", { name: "Show 1 more change" }));
    expect(several).toHaveTextContent("cleared Owner (was Ada)");
    expect(card("Sprint 1", 0)).toHaveTextContent("Grace Hopper created the record");
    // A new record's values are behind a button: this is a skim.
    expect(card("Sprint 1", 0)).not.toHaveTextContent("set Status to Todo");
    await user.click(within(card("Sprint 1", 0)).getByRole("button", { name: "Show 1 field" }));
    expect(card("Sprint 1", 0)).toHaveTextContent("set Status to Todo");
    expect(card("Old plan")).toHaveTextContent("Someone deleted the record");
  });

  it("cuts long values and comments until asked for the rest", async () => {
    const user = userEvent.setup();
    routes({}, feedRoute([item("h4", "update", HOUR, { changes: { fld_notes: { old: null, new: LONG } } }), item("c9", "comment", 2 * HOUR, { comment: LONG })]));
    renderApp({ route: "/history" });
    const row = (await screen.findAllByRole("listitem")).find((r) => r.textContent?.includes("set Notes"))!;
    expect(row).not.toHaveTextContent(LONG);
    await user.click(within(row).getByRole("button", { name: "more" }));
    expect(row).toHaveTextContent(LONG);
    await user.click(within(row).getByRole("button", { name: "less" }));
    expect(row).not.toHaveTextContent(LONG);
    await user.click(screen.getByRole("button", { name: "Show the whole comment" }));
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows how long ago and the exact time on every item, as text", async () => {
    routes();
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    const items = screen.getAllByRole("article").flatMap((a) => within(a).getAllByRole("listitem")).filter((li) => li.querySelector("time"));
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const li of items) expect(li.querySelectorAll("time")).toHaveLength(2);
    const comment = items.find((r) => r.textContent?.includes("commented"))!;
    const [relative, exact] = Array.from(comment.querySelectorAll("time"));
    expect(relative).toHaveTextContent("5 minutes ago");
    expect(exact).toHaveTextContent("Oct 18, 2026, 3:55 PM");
    expect(relative).toHaveAttribute("datetime", new Date(NOW - 5 * MIN).toISOString());
    expect(exact).toHaveAttribute("datetime", new Date(NOW - 5 * MIN).toISOString());
    const old = items.find((r) => r.textContent?.includes("Someone deleted"))!;
    expect(old).toHaveTextContent("yesterday");
    expect(old).toHaveTextContent("Oct 17, 2026, 2:00 PM");
  });

  it("uses the person's time zone for the exact time and the days", async () => {
    // 11:55 PM on the 17th in Los Angeles is 6:55 AM on the 18th UTC.
    routes({ "GET /api/auth/me": { ...USER, timezone: "America/Los_Angeles" } }, feedRoute([item("c1", "comment", 0, { created_at: Date.UTC(2026, 9, 18, 6, 55), comment: "late" })], []));
    renderApp({ route: "/history" });
    const li = (await screen.findAllByRole("listitem")).find((r) => r.textContent?.includes("commented"))!;
    expect(li).toHaveTextContent("Oct 17, 2026, 11:55 PM");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Yesterday"]);
  });

  it("filters by workspace, project, person and kind, writing them to the URL and asking again", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    expect(lastQuery(api).get("kind")).toBeNull();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(lastQuery(api).get("kind")).toBe("update"));
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    for (const [chip, kind] of [["New records", "create"], ["Deleted", "delete"], ["Comments", "comment"]] as const) {
      await user.click(screen.getByRole("button", { name: chip }));
      await waitFor(() => expect(lastQuery(api).get("kind")).toBe(kind));
    }

    await user.click(screen.getByRole("button", { name: "Workspace: All workspaces" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Acme" }));
    await waitFor(() => expect(lastQuery(api).get("workspace")).toBe("wsp1"));
    expect(lastQuery(api).get("kind")).toBe("comment");

    // The project list follows the workspace.
    await user.click(screen.getByRole("button", { name: "Project: All projects" }));
    const projects = await screen.findByRole("menu");
    expect(within(projects).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["All projects", "CRM", "Ops"]);
    await user.click(within(projects).getByRole("menuitemradio", { name: "Ops" }));
    await waitFor(() => expect(lastQuery(api).get("base")).toBe("app2"));

    // So does the list of people.
    await user.click(screen.getByRole("button", { name: "Person: Everyone" }));
    const people = await screen.findByRole("menu");
    expect(within(people).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["Everyone", "ALAda Lovelace", "GHGrace Hopper"]);
    await user.click(within(people).getByRole("menuitemradio", { name: "Grace Hopper" }));
    await waitFor(() => expect(lastQuery(api).get("user")).toBe("usr2"));
    expect(screen.getByRole("button", { name: "Person: Grace Hopper" })).toBeInTheDocument();

    // Another workspace clears the project; All clears the kind.
    await user.click(screen.getByRole("button", { name: "Workspace: Acme" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Home" }));
    await waitFor(() => expect(lastQuery(api).get("workspace")).toBe("wsp2"));
    expect(lastQuery(api).get("base")).toBeNull();
    expect(lastQuery(api).get("user")).toBe("usr2");
    await user.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(lastQuery(api).get("kind")).toBeNull());
  });

  it("opens filtered by what the link says, showing the project's workspace", async () => {
    stubDesktop();
    const api = routes();
    renderApp({ route: "/history?base=app2&user=usr2&kind=update&order=oldest" });
    await screen.findAllByRole("article");
    const q = lastQuery(api);
    expect([q.get("base"), q.get("user"), q.get("kind"), q.get("order")]).toEqual(["app2", "usr2", "update", "oldest"]);
    expect(await screen.findByRole("button", { name: "Workspace: Acme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project: Ops" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Person: Grace Hopper" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    // The menu opens that workspace, as it does for any page of one.
    expect(await screen.findByRole("list", { name: "Projects in Acme" })).toBeInTheDocument();
  });

  it("flips between newest and oldest first", async () => {
    const user = userEvent.setup();
    const api = routes();
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    expect(lastQuery(api).get("order")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sort: Newest first" }));
    await waitFor(() => expect(lastQuery(api).get("order")).toBe("oldest"));
    expect(screen.getByRole("button", { name: "Sort: Oldest first" })).toHaveTextContent("Oldest first");
    await user.click(screen.getByRole("button", { name: "Sort: Oldest first" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sort: Newest first" })).toBeInTheDocument());
    await waitFor(() => expect(lastQuery(api).get("order")).toBeNull());
  });

  it("loads more, appending to the feed, until there is no more", async () => {
    const user = userEvent.setup();
    const api = routes();
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.queryByText(/Tue to Wed/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.callsTo("GET /api/history").at(-1)!.query.get("before")).toBe("p2"));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(5));
    expect(screen.getByRole("heading", { level: 2, name: "Thursday, Oct 15" })).toBeInTheDocument();
    expect(card("Sprint 1", 1)).toHaveTextContent("changed Due from Tue to Wed");
    // The first page stays; nothing is asked for twice.
    expect(screen.getAllByRole("article")[0]).toHaveAccessibleName("Activity on Big deal");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.getByText(/That is everything/)).toBeInTheDocument();
    expect(api.callsTo("GET /api/history")).toHaveLength(2);
  });

  it("continues a card across pages when the same record carries on", async () => {
    const user = userEvent.setup();
    routes({}, feedRoute([item("h2", "update", HOUR, { changes: { fld_due: { old: "A", new: "B" } } })], [item("h1", "update", 2 * HOUR, { changes: { fld_due: { old: "B", new: "C" } } })]));
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(card("Big deal")).getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("says when there is nothing, and when nothing matches the filters", async () => {
    routes({}, feedRoute([], []));
    renderApp({ route: "/history" });
    expect(await screen.findByText(/Nothing has happened yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("says when nothing matches the filters", async () => {
    routes({}, feedRoute([], []));
    renderApp({ route: "/history?kind=comment" });
    expect(await screen.findByText("No activity like that yet.")).toBeInTheDocument();
  });

  it("shows an error with a way to try again", async () => {
    const user = userEvent.setup();
    let fail = true;
    routes({}, () => (fail ? { status: 500, json: { error: { code: "internal", message: "boom" } } } : { items: [PAGE_1[0]], next: null, fields: FIELDS }));
    renderApp({ route: "/history" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the history");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "Activity on Big deal" })).toBeInTheDocument();
  });

  it("is linked from the menu next to the Trash, and from the workspace and project menus", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/history" });
    await screen.findAllByRole("article");
    const nav = screen.getByRole("navigation", { name: /./ });
    const link = within(nav).getAllByRole("link", { name: "History" }).at(-1)!;
    expect(link).toHaveAttribute("href", "/history");
    // On its own page, unfiltered, it is the current one; the Trash is not.
    expect(link).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("link", { name: "Trash" }).at(-1)).not.toHaveAttribute("aria-current", "page");
    expect(link.compareDocumentPosition(within(nav).getAllByRole("link", { name: "Trash" }).at(-1)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Workspace options for Acme" }));
    expect(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "History" })).toHaveAttribute("href", "/history?workspace=wsp1");
    await user.keyboard("{Escape}");
  });
});

describe("grouping the feed", () => {
  const at = (h: number) => Date.UTC(2026, 9, 18, h);
  const mk = (id: string, record: string, h: number): ActivityItem => item(id, "update", 0, { created_at: at(h), record: { id: record, name: record, deleted: false } });

  it("groups consecutive items on one record on one day", () => {
    const groups = groupActivity([mk("a", "r1", 12), mk("b", "r1", 11), mk("c", "r2", 10), mk("d", "r1", 9)], "UTC");
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([["a", ["a", "b"]], ["c", ["c"]], ["d", ["d"]]]);
  });

  it("starts a new card when the day changes, in the person's zone", () => {
    const items = [mk("a", "r1", 12), item("b", "update", 0, { created_at: at(12) - DAY, record: { id: "r1", name: "r1", deleted: false } })];
    expect(groupActivity(items, "UTC")).toHaveLength(2);
    // 3 AM and 5 AM UTC are on one day in Los Angeles' evening before.
    const early = [mk("a", "r1", 5), mk("b", "r1", 3)];
    expect(groupActivity(early, "UTC")).toHaveLength(1);
    expect(groupActivity([mk("a", "r1", 8), mk("b", "r1", 6)], "America/Los_Angeles")).toHaveLength(2);
  });

  it("names the days", () => {
    const now = Date.UTC(2026, 9, 18, 12);
    expect(dayKey(now, "Pacific/Auckland")).toBe("2026-10-19");
    expect(dayLabel("2026-10-18", now, "UTC")).toBe("Today");
    expect(dayLabel("2026-10-17", now, "UTC")).toBe("Yesterday");
    expect(dayLabel("2026-10-12", now, "UTC")).toBe("Monday, Oct 12");
    expect(dayLabel("2025-12-31", now, "UTC")).toBe("Wednesday, Dec 31, 2025");
    // Yesterday across the end of a month and of a year.
    expect(dayLabel("2026-09-30", Date.UTC(2026, 9, 1, 12), "UTC")).toBe("Yesterday");
    expect(dayLabel("2025-12-31", Date.UTC(2026, 0, 1, 12), "UTC")).toBe("Yesterday");
    const sections = sectionByDay(groupActivity([mk("a", "r1", 12), item("b", "update", 0, { created_at: at(12) - DAY })], "UTC"), now, "UTC");
    expect(sections.map((s) => [s.day, s.label, s.groups.length])).toEqual([["2026-10-18", "Today", 1], ["2026-10-17", "Yesterday", 1]]);
  });
});
