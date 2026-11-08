/**
 * The command palette (NAV-9): what Ctrl K opens, how its results are grouped, which actions it offers for what
 * was typed, the scopes, and the keyboard. The core CommandPalette's own behaviour is in components/ui/overlays.test.
 */
import { useLocation } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseSummary, SearchResult, TableSummary, WorkspaceSummary } from "@/api/types";
import { apiError, mockApi, renderWithProviders, stubDesktop, stubPhone, type RecordedCall } from "@/test/utils";
import { NavDialogsProvider } from "./NavDialogs";
import { Highlight, SearchBarProvider, SearchButton, actionMatches, groupResults, searchResultHref, shortcutLabel, type SearchHere } from "./SearchEverything";

afterEach(() => vi.unstubAllGlobals());

const table = (id: string, name: string, color: string): TableSummary => ({ id, name, color, record_count: 3, body_field_id: null, home_date_field_id: null, done_field_id: null, record_noun: "" });
const base = (id: string, name: string, role: string, over: Partial<BaseSummary> = {}): BaseSummary => ({ id, workspace_id: "wsp1", name, color: "green", role, is_top_level: false, people: [], tables: [], ...over });

function workspaces(role = "owner"): WorkspaceSummary[] {
  return [
    {
      id: "wsp1",
      name: "Household",
      color: "green",
      role,
      root_base_id: "app0",
      member_count: 1,
      pending_invite_count: 0,
      bases: [
        base("app0", "Household", role, { is_top_level: true, tables: [table("tbl1", "Chores", "orange"), table("tbl2", "Chore log", "pink")] }),
        // A viewer-only folder: nothing can be added to its collections.
        base("app1", "Chore archive", "viewer", { tables: [table("tbl3", "Old chores", "cyan")] }),
      ],
    },
    { id: "wsp2", name: "Work", color: "blue", role: "owner", root_base_id: "app9", member_count: 1, pending_invite_count: 0, bases: [base("app9", "Work", "owner", { workspace_id: "wsp2", is_top_level: true, tables: [table("tbl9", "Roadmap", "purple")] })] },
  ];
}

const where = { workspace_id: "wsp1", workspace_name: "Household", workspace_color: "green", name_matches: [], snippet_matches: [] };
const RESULTS: SearchResult[] = [
  { kind: "record", id: "rec1", name: "Take out trash", ...where, base_id: "app0", base_name: "Household", table_id: "tbl1", table_name: "Chores", record_id: "rec1", snippet: "every Tuesday" },
  { kind: "base", id: "app1", name: "Chore archive", ...where, base_id: "app1", base_name: "Chore archive", base_color: "teal" },
  { kind: "workspace", id: "wsp1", name: "Household", ...where },
  { kind: "view", id: "viw2", name: "Chores by person", ...where, base_id: "app0", base_name: "Household", table_id: "tbl1", table_name: "Chores", view_id: "viw2", view_type: "kanban" },
  { kind: "table", id: "tbl2", name: "Chore log", ...where, base_id: "app0", base_name: "Household", table_id: "tbl2", table_name: "Chore log" },
];

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function renderPalette(here?: SearchHere) {
  return renderWithProviders(
    <NavDialogsProvider>
      <SearchBarProvider here={here}>
        <SearchButton />
        <p>Elsewhere on the page</p>
        <Where />
      </SearchBarProvider>
    </NavDialogsProvider>,
  );
}

function routes(over: { role?: string; search?: unknown; extra?: Record<string, unknown> } = {}) {
  return mockApi({
    "GET /api/workspaces": workspaces(over.role),
    "GET /api/search": (over.search ?? { results: RESULTS }) as never,
    ...(over.extra as Record<string, never>),
  });
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Search everything" }));
  const input = await screen.findByRole("combobox", { name: "Search" });
  await waitFor(() => expect(input).toHaveFocus());
  return input;
}

const groupNames = (list: HTMLElement) => within(list).getAllByRole("group").map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)!.textContent);

describe("searchResultHref", () => {
  it("opens each kind where it lives, a record expanded over its collection like a notification link", () => {
    expect(RESULTS.map(searchResultHref)).toEqual(["/base/app0/tbl1?record=rec1", "/base/app1", "/workspace/wsp1", "/base/app0/tbl1/viw2", "/base/app0/tbl2"]);
  });
});

describe("actionMatches", () => {
  it("wants every typed word to start a word of the action, in any order", () => {
    expect(actionMatches("new rec cli", "New record in Clients")).toBe(true);
    expect(actionMatches("clients new", "New record in Clients")).toBe(true);
    expect(actionMatches("home", "Go to Home")).toBe(true);
    expect(actionMatches("ome", "Go to Home")).toBe(false);
    expect(actionMatches("new rec", "New collection")).toBe(false);
    expect(actionMatches("create", "New collection", "add create")).toBe(true);
  });

  it("matches nothing when nothing is typed", () => {
    expect(actionMatches("", "Go to Home")).toBe(false);
    expect(actionMatches("   ", "Go to Home")).toBe(false);
  });
});

describe("groupResults", () => {
  it("orders the groups records, collections, folders, views, workspaces, then comments, and leaves empty ones out", () => {
    const comment: SearchResult = { ...RESULTS[0]!, kind: "comment", id: "cmt1" };
    expect(groupResults([comment, ...RESULTS]).map((g) => [g.kind, g.items.length])).toEqual([
      ["record", 1],
      ["table", 1],
      ["base", 1],
      ["view", 1],
      ["workspace", 1],
      ["comment", 1],
    ]);
    expect(groupResults([RESULTS[2]!]).map((g) => g.kind)).toEqual(["workspace"]);
    expect(groupResults([])).toEqual([]);
  });
});

describe("the palette on a desktop", () => {
  it("opens with Ctrl K or Cmd K from anywhere, and Escape closes it and puts focus back where it was", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette();
    const button = screen.getByRole("button", { name: "Search everything" });
    button.focus();
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByRole("combobox", { name: "Search" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Search everything" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(button).toHaveFocus();

    await user.click(screen.getByText("Elsewhere on the page"));
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("combobox", { name: "Search" })).toBeInTheDocument();
  });

  it("selects what was typed when the key is pressed again, instead of closing or stacking a second palette", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette();
    const input = await openPalette(user);
    await user.keyboard("cho");
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe(3);
  });

  it("yields Ctrl K to an editor that handled it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderWithProviders(
      <SearchBarProvider>
        <textarea aria-label="Editor" onKeyDown={(e) => e.key === "k" && e.preventDefault()} />
        <textarea aria-label="Plain" />
      </SearchBarProvider>,
    );
    await user.click(screen.getByRole("textbox", { name: "Editor" }));
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Editor" })).toHaveFocus();
    // A field that does not use the key still gets the palette.
    await user.click(screen.getByRole("textbox", { name: "Plain" }));
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "Search everything" })).toBeInTheDocument();
  });

  it("groups results as records, collections, folders, views and workspaces, each with its mark", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("cho");
    const list = screen.getByRole("listbox", { name: "Results" });
    const record = await within(list).findByRole("option", { name: /Take out trash/ });
    // One request for the whole word, not one per key.
    expect(api.callsTo("GET /api/search")).toHaveLength(1);
    expect(api.callsTo("GET /api/search")[0]!.query.get("q")).toBe("cho");
    expect(api.callsTo("GET /api/search")[0]!.query.get("limit")).toBe("20");
    // Actions that fit the text come after the results.
    expect(groupNames(list)).toEqual(["Records", "Collections", "Folders", "Views", "Workspaces", "Actions"]);
    // A record carries its collection's 8 px mark in that collection's color, and says which collection it is in.
    const mark = record.querySelector(".ob-mark-8");
    expect(mark).toHaveClass("ob-hue-orange");
    expect(record).toHaveTextContent("Chores");
    expect(record).toHaveTextContent("every Tuesday");
    expect(within(list).getByRole("option", { name: "Chore log" }).querySelector(".ob-mark-14")).toHaveClass("ob-hue-pink");
    expect(within(list).getByRole("option", { name: /Chore archive/ }).querySelector(".ob-mark-14")).toHaveClass("ob-hue-teal");
    // A view says its layout by an icon, a workspace is its color.
    expect(within(list).getByRole("option", { name: /Chores by person/ }).querySelector("svg")).not.toBeNull();
    expect(within(list).getByRole("option", { name: /Household/ }).querySelector(".ob-mark-14")).toHaveClass("ob-hue-green");
  });

  it("does not list the top-level project as a folder", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ search: { results: [{ kind: "base", id: "app0", name: "Household", ...where, base_id: "app0", base_name: "Household" }, RESULTS[1]] } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("house");
    await screen.findByRole("option", { name: /Chore archive/ });
    expect(screen.queryByRole("option", { name: /^Household/ })).not.toBeInTheDocument();
  });

  it("names the workspace of a result only when it is not the one the person is in", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const elsewhere: SearchResult = { ...RESULTS[0]!, id: "rec7", record_id: "rec7", name: "Ship it", workspace_id: "wsp2", workspace_name: "Work", table_id: "tbl9", table_name: "Roadmap" };
    routes({ search: { results: [RESULTS[0], elsewhere] } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("a");
    expect(await screen.findByRole("option", { name: /Take out trash/ })).not.toHaveTextContent("Household");
    expect(screen.getByRole("option", { name: /Ship it/ })).toHaveTextContent("Roadmap · Work");
  });

  it("walks the results with the arrow keys across groups, wraps, and opens one with Enter", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette({ workspaceId: "wsp1" });
    const input = await openPalette(user);
    await user.keyboard("cho");
    await screen.findByRole("option", { name: /Take out trash/ });
    // The best match is already highlighted.
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(1);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Take out trash");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Chore log");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { selected: true }).id);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    // Wraps to the last row, which is an action.
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("New record in Chore log");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app0/tbl2");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens a result with a click", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette();
    await openPalette(user);
    await user.keyboard("cho");
    await user.click(await screen.findByRole("option", { name: /Chores by person/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app0/tbl1/viw2");
  });

  it("does not let Enter open a result for text that has since been typed past", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette();
    await openPalette(user);
    await user.keyboard("cho");
    await screen.findByRole("option", { name: /Take out trash/ });
    // The next key and Enter land before the new search has been asked for.
    await user.keyboard("r{Enter}");
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("marks where the text matched, and shows a record's matching property with its snippet", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const results: SearchResult[] = [
      { ...RESULTS[1]!, name_matches: [{ start: 0, end: 4 }] },
      { ...RESULTS[0]!, id: "rec2", record_id: "rec2", name: "Spring launch", snippet: "…and Steven will be in charge of marketing. That may…", snippet_matches: [{ start: 33, end: 37 }], field_name: "Notes" },
    ];
    routes({ search: { results } });
    renderPalette();
    await openPalette(user);
    await user.keyboard("mark");
    const record = await screen.findByRole("option", { name: /Spring launch/ });
    expect(record).toHaveTextContent("Notes: …and Steven will be in charge of marketing. That may…");
    expect([...record.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["mark"]);
    expect([...screen.getByRole("option", { name: /Chore archive/ }).querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Chor"]);
  });

  it("lists comments last, as what was said, by whom on which record, and opens the record", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const comment: SearchResult = { kind: "comment", id: "cmt1", name: "Take out trash", ...where, base_id: "app0", base_name: "Household", table_id: "tbl1", table_name: "Chores", record_id: "rec1", snippet: "…remember the recycling on Tuesday", author_name: "Ada" };
    routes({ search: { results: [RESULTS[0], comment] } });
    renderPalette();
    await openPalette(user);
    await user.keyboard("recycling");
    const option = await screen.findByRole("option", { name: /remember the recycling/ });
    expect(groupNames(screen.getByRole("listbox"))[1]).toBe("Comments");
    expect(option).toHaveTextContent("Ada on Take out trash");
    await user.click(option);
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app0/tbl1?record=rec1");
  });

  it("says when nothing matches, and explains a failed search", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ search: { results: [] } });
    renderPalette();
    await openPalette(user);
    await user.keyboard("zzz");
    expect(await within(screen.getByRole("listbox")).findByText("No matches for “zzz”")).toBeInTheDocument();
    api.set("GET /api/search", apiError(500, "internal", "Database is busy"));
    await user.keyboard("y");
    expect(await screen.findByRole("alert")).toHaveTextContent("Search is unavailable: Database is busy");
  });

  it("starts from nothing each time it opens", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette({ workspaceId: "wsp1" });
    const input = await openPalette(user);
    await user.keyboard("cho");
    await user.click(within(screen.getByRole("group", { name: "Search in" })).getByRole("button", { name: "This workspace" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const again = await openPalette(user);
    expect(again).toHaveValue("");
    expect(input).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Search in" })).getByRole("button", { name: "Everywhere" })).toHaveAttribute("aria-pressed", "true");
  });

  it("names the shortcut as the keyboard does: ⌘K on Apple devices, Ctrl K elsewhere", () => {
    expect(shortcutLabel(true)).toBe("⌘K");
    expect(shortcutLabel(false)).toBe("Ctrl K");
  });
});

describe("actions", () => {
  it("offers Go to Home, New collection and Open settings before anything is typed, and runs one with Enter", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    const list = screen.getByRole("listbox");
    expect(groupNames(list)).toEqual(["Actions"]);
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["New collection", "Go to Home", "Open settings"]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/workspace/wsp1");
  });

  it("lists New record in each collection the person can add to that fits the text, and not the viewer-only ones", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ search: { results: [] } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("new record chore");
    const options = await screen.findAllByRole("option");
    // "Old chores" is in a folder the person can only read.
    expect(options.map((o) => o.textContent)).toEqual(["New record in Chores", "New record in Chore log"]);
    await waitFor(() => expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "false"));
  });

  it("adds a record to the collection and opens it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ search: { results: [] }, extra: { "POST /api/tables/tbl1/records": { records: [{ id: "recNew", values: {}, created_at: 0 }] } } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("new record chores");
    await user.click(await screen.findByRole("option", { name: "New record in Chores" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/base/app0/tbl1?record=recNew"));
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toMatchObject({ records: [{ values: {} }] });
  });

  it("says so when the record could not be added", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ search: { results: [] }, extra: { "POST /api/tables/tbl1/records": apiError(500, "internal", "Disk full") } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("new record chores");
    await user.click(await screen.findByRole("option", { name: "New record in Chores" }));
    expect(await screen.findByText("Could not add the record")).toBeInTheDocument();
    expect(screen.getByTestId("where")).not.toHaveTextContent("record=");
  });

  it("offers nothing to add to for a viewer, and no New collection", async () => {
    stubDesktop();
    const user = userEvent.setup();
    mockApi({
      "GET /api/workspaces": workspaces().map((w) => ({ ...w, role: "viewer", bases: w.bases.map((b) => ({ ...b, role: "viewer" })) })),
      "GET /api/search": { results: [] },
    });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("new");
    await waitFor(() => expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryByRole("option", { name: /^New / })).not.toBeInTheDocument();
    expect(within(screen.getByRole("listbox")).getByText("No matches for “new”")).toBeInTheDocument();
  });

  it("opens the New collection dialog for the workspace's top level", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ search: { results: [] } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("new coll");
    await user.click(await screen.findByRole("option", { name: "New collection" }));
    expect(await screen.findByRole("dialog", { name: "New collection" })).toBeInTheDocument();
  });

  it("finds Go to Home and Open settings by their words, and settings are the workspace's for an owner and the account's for everyone else", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ search: { results: [] } });
    const owner = renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("sett");
    await user.click(await screen.findByRole("option", { name: "Open settings" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/workspace/wsp1/settings");
    owner.unmount();

    mockApi({ "GET /api/workspaces": workspaces("editor"), "GET /api/search": { results: [] } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("settings");
    await user.click(await screen.findByRole("option", { name: "Open settings" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/account");
  });
});

describe("scopes", () => {
  it("offers Everywhere and This workspace in the top level, This folder in a folder, and searches only there", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ search: (c: RecordedCall) => ({ results: c.query.get("base") ? [] : RESULTS }) });
    renderPalette({ workspaceId: "wsp1", baseId: "app1" });
    await openPalette(user);
    const scopes = screen.getByRole("group", { name: "Search in" });
    await waitFor(() => expect(within(scopes).getAllByRole("button").map((b) => b.textContent)).toEqual(["Everywhere", "This workspace", "This folder"]));
    expect(within(scopes).getByRole("button", { name: "Everywhere" })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("cho");
    await screen.findByRole("option", { name: /Take out trash/ });
    expect(api.callsTo("GET /api/search").at(-1)!.query.get("base")).toBeNull();

    await user.click(within(scopes).getByRole("button", { name: "This folder" }));
    expect(within(scopes).getByRole("button", { name: "This folder" })).toHaveAttribute("aria-pressed", "true");
    expect(await within(screen.getByRole("listbox")).findByText("No matches for “cho” in Chore archive")).toBeInTheDocument();
    expect(api.callsTo("GET /api/search").at(-1)!.query.get("base")).toBe("app1");
    // The click kept focus in the field, so typing goes on.
    expect(screen.getByRole("combobox", { name: "Search" })).toHaveFocus();

    await user.click(within(scopes).getByRole("button", { name: "This workspace" }));
    await screen.findByRole("option", { name: /Take out trash/ });
    expect(api.callsTo("GET /api/search").at(-1)!.query.get("workspace")).toBe("wsp1");
    expect(api.callsTo("GET /api/search").at(-1)!.query.get("base")).toBeNull();
  });

  it("has no This folder in the top-level project, which is not a folder to the person", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette({ workspaceId: "wsp1", baseId: "app0" });
    await openPalette(user);
    const scopes = screen.getByRole("group", { name: "Search in" });
    await waitFor(() => expect(within(scopes).getAllByRole("button").map((b) => b.textContent)).toEqual(["Everywhere", "This workspace"]));
  });

  it("shows no scopes on a page outside any workspace", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderPalette();
    await openPalette(user);
    expect(screen.queryByRole("group", { name: "Search in" })).not.toBeInTheDocument();
  });

  it("keeps the actions to the scope: New record only in this workspace's collections", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ search: { results: [] } });
    renderPalette({ workspaceId: "wsp1" });
    await openPalette(user);
    await user.keyboard("new record");
    expect(await screen.findByRole("option", { name: /New record in Roadmap/ })).toHaveTextContent("Work");
    await user.click(within(screen.getByRole("group", { name: "Search in" })).getByRole("button", { name: "This workspace" }));
    await waitFor(() => expect(screen.queryByRole("option", { name: /Roadmap/ })).not.toBeInTheDocument());
    expect(screen.getByRole("option", { name: /New record in Chores/ })).toBeInTheDocument();
  });

  it("moves to a scope chip with Tab and chooses it from the keyboard, with focus back in the field", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    renderPalette({ workspaceId: "wsp1" });
    const input = await openPalette(user);
    await screen.findByRole("button", { name: "This workspace" });
    await user.keyboard("cho");
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "This workspace" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(input).toHaveFocus();
    await waitFor(() => expect(api.callsTo("GET /api/search").at(-1)!.query.get("workspace")).toBe("wsp1"));
  });
});

describe("the palette on a phone", () => {
  it("is a full-screen palette with Cancel, opened by the header's search button", async () => {
    stubPhone();
    const user = userEvent.setup();
    routes();
    renderPalette({ workspaceId: "wsp1" });
    const button = screen.getByRole("button", { name: "Search everything" });
    // 44 px target (the IconButton's phone size).
    expect(button).toHaveClass("max-md:size-control-touch");
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Search everything" });
    expect(dialog).toHaveClass("inset-x-0");
    expect(dialog).not.toHaveClass("rounded-lg");
    const input = within(dialog).getByRole("combobox", { name: "Search" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "cho");
    await user.click(await within(dialog).findByRole("option", { name: "Chore log" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app0/tbl2");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search everything" })).not.toBeInTheDocument());

    await user.click(button);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("Highlight", () => {
  it("marks each match, counting code points so an emoji before a match does not shift it", () => {
    const { container } = render(
      <p>
        <Highlight
          text="🎉 Party party"
          matches={[
            { start: 2, end: 7 },
            { start: 8, end: 13 },
          ]}
        />
      </p>,
    );
    expect(container.querySelector("p")).toHaveTextContent("🎉 Party party");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Party", "party"]);
  });

  it("leaves out ranges that do not fit the text, and shows the text alone without matches", () => {
    const { container } = render(
      <p>
        <Highlight
          text="Chores"
          matches={[
            { start: 3, end: 2 },
            { start: 4, end: 40 },
          ]}
        />
        <Highlight text=" and more" matches={null} />
      </p>,
    );
    expect(container.querySelector("p")).toHaveTextContent("Chores and more");
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });
});
