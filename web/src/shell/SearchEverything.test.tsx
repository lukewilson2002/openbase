import { useLocation } from "react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult, WorkspaceSummary } from "@/api/types";
import { apiError, mockApi, renderWithProviders, stubDesktop, type RecordedCall } from "@/test/utils";
import { Highlight, SEARCH_BUTTON_ROOM, SEARCH_FIELD_MIN, SearchEverything, searchFits, searchResultHref, searchResultPath, shortcutLabel } from "./SearchEverything";

afterEach(() => vi.unstubAllGlobals());

const where = { workspace_id: "wsp1", workspace_name: "Household", workspace_color: "green", name_matches: [], snippet_matches: [] };
const RESULTS: SearchResult[] = [
  { kind: "record", id: "rec1", name: "Take out trash", ...where, base_id: "app1", base_name: "Chores", table_id: "tbl1", table_name: "Chores", record_id: "rec1", snippet: "every Tuesday" },
  { kind: "base", id: "app1", name: "Chores", ...where, base_id: "app1", base_name: "Chores", base_icon: "list-checks", base_color: "green" },
  { kind: "workspace", id: "wsp1", name: "Household", ...where },
  { kind: "view", id: "viw2", name: "Chores by person", ...where, base_id: "app1", base_name: "Chores", table_id: "tbl1", table_name: "Chores", view_id: "viw2", view_type: "kanban" },
  { kind: "table", id: "tbl2", name: "Chore log", ...where, base_id: "app1", base_name: "Chores", table_id: "tbl2", table_name: "Chore log" },
];

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function renderSearch() {
  return renderWithProviders(
    <>
      <SearchEverything />
      <p>Elsewhere on the page</p>
      <Where />
    </>,
  );
}

const searchApi = (reply: (q: string) => unknown = () => ({ results: RESULTS })) => mockApi({ "GET /api/search": (call: RecordedCall) => reply(call.query.get("q") ?? "") });

describe("searchResultHref and searchResultPath", () => {
  it("open each kind where it lives, a record expanded over its table like a notification link", () => {
    expect(RESULTS.map(searchResultHref)).toEqual(["/base/app1/tbl1?record=rec1", "/base/app1", "/workspace/wsp1", "/base/app1/tbl1/viw2", "/base/app1/tbl2"]);
    expect(RESULTS.map(searchResultPath)).toEqual(["Household › Chores › Chores", "Household", "", "Household › Chores › Chores", "Household › Chores"]);
  });
});

describe("SearchEverything on a desktop", () => {
  it("searches as you type, once the typing pauses, and groups the results by kind", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = searchApi();
    renderSearch();
    const box = screen.getByRole("combobox", { name: "Search everything" });
    await user.type(box, "cho");
    const list = await screen.findByRole("listbox", { name: "Search results" });
    await within(list).findByRole("option", { name: /Take out trash/ });
    // One request for the whole word, not one per key.
    expect(api.callsTo("GET /api/search")).toHaveLength(1);
    expect(api.callsTo("GET /api/search")[0]!.query.get("q")).toBe("cho");
    expect(api.callsTo("GET /api/search")[0]!.query.get("limit")).toBe("20");
    const groups = within(list).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-labelledby") && document.getElementById(g.getAttribute("aria-labelledby")!)!.textContent)).toEqual(["Workspaces", "Projects", "Tables", "Views", "Records"]);
    const record = within(list).getByRole("option", { name: /Take out trash/ });
    expect(record).toHaveTextContent("every Tuesday");
    expect(record).toHaveTextContent("Household › Chores › Chores");
    expect(box).toHaveAttribute("aria-expanded", "true");
  });

  it("lists comments last, as what was said, by whom on which record, and opens the record", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const comment: SearchResult = { kind: "comment", id: "cmt1", name: "Take out trash", ...where, base_id: "app1", base_name: "Chores", table_id: "tbl1", table_name: "Chores", record_id: "rec1", snippet: "…remember the recycling on Tuesday", author_name: "Ada" };
    searchApi(() => ({ results: [RESULTS[0], comment] }));
    renderSearch();
    await user.type(screen.getByRole("combobox", { name: "Search everything" }), "recycling");
    const list = await screen.findByRole("listbox", { name: "Search results" });
    const option = await within(list).findByRole("option", { name: /remember the recycling/ });
    const groups = within(list).getAllByRole("group");
    expect(groups.map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)!.textContent)).toEqual(["Records", "Comments"]);
    expect(option).toHaveTextContent("Ada on Take out trash · Household › Chores › Chores");
    await user.click(option);
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1?record=rec1");
  });

  it("walks the results with the arrow keys and opens one with Enter", async () => {
    stubDesktop();
    const user = userEvent.setup();
    searchApi();
    renderSearch();
    const box = screen.getByRole("combobox", { name: "Search everything" });
    await user.type(box, "cho");
    await screen.findByRole("option", { name: /Take out trash/ });
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const active = screen.getByRole("option", { selected: true });
    expect(active).toHaveTextContent("Chores");
    expect(box).toHaveAttribute("aria-activedescendant", active.id);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    // Wraps around to the last one: the record.
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Take out trash");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1?record=rec1");
    expect(box).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens a result with a click", async () => {
    stubDesktop();
    const user = userEvent.setup();
    searchApi();
    renderSearch();
    await user.type(screen.getByRole("combobox", { name: "Search everything" }), "cho");
    await user.click(await screen.findByRole("option", { name: /Chores by person/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viw2");
  });

  it("jumps to the box with Ctrl+K or ⌘K, and Escape closes the list and then clears it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    searchApi();
    renderSearch();
    const box = screen.getByRole("combobox", { name: "Search everything" });
    await user.keyboard("{Control>}k{/Control}");
    expect(box).toHaveFocus();
    await user.click(screen.getByText("Elsewhere on the page"));
    await user.keyboard("{Meta>}k{/Meta}");
    expect(box).toHaveFocus();
    await user.keyboard("cho");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box).toHaveValue("cho");
    await user.keyboard("{Escape}");
    expect(box).toHaveValue("");
  });

  it("shows its shortcut while it waits, and not once it has the focus or a query", async () => {
    stubDesktop();
    const user = userEvent.setup();
    searchApi();
    renderSearch();
    const box = screen.getByRole("combobox", { name: "Search everything" });
    expect(box).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");
    const hint = document.querySelector("kbd");
    expect(hint).toHaveTextContent(shortcutLabel());
    // Hidden by CSS while the box has the focus; gone once there is a query.
    expect(hint).toHaveClass("group-focus-within/search:hidden");
    await user.click(box);
    await user.keyboard("cho");
    expect(document.querySelector("kbd")).toBeNull();
    await user.clear(box);
    expect(document.querySelector("kbd")).not.toBeNull();
  });

  it("names the shortcut as the keyboard does: ⌘K on Apple devices, Ctrl K elsewhere", () => {
    expect(shortcutLabel(true)).toBe("⌘K");
    expect(shortcutLabel(false)).toBe("Ctrl K");
  });

  it("says when nothing matches", async () => {
    stubDesktop();
    const user = userEvent.setup();
    searchApi(() => ({ results: [] }));
    renderSearch();
    await user.type(screen.getByRole("combobox", { name: "Search everything" }), "zzz");
    expect(await screen.findByText("No matches for “zzz”")).toBeInTheDocument();
  });

  it("shows that it is searching, and explains a failure", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const waiting: ((v: unknown) => void)[] = [];
    const answer = (v: unknown) => waiting.splice(0).forEach((r) => r(v));
    mockApi({ "GET /api/search": () => new Promise((r) => waiting.push(r)) });
    renderSearch();
    await user.type(screen.getByRole("combobox", { name: "Search everything" }), "cho");
    const list = await screen.findByRole("listbox", { name: "Search results" });
    expect(within(list).getByRole("status")).toHaveTextContent("Searching");
    expect(list).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(waiting).toHaveLength(1));
    expect(within(list).getByRole("status")).toHaveTextContent("Searching");
    answer(apiError(500, "internal", "Database is busy"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Search is unavailable: Database is busy");
  });
});

describe("SearchEverything on a phone", () => {
  it("is a search button that opens the box over the page", async () => {
    const user = userEvent.setup();
    searchApi();
    renderSearch();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Search everything" }));
    const sheet = await screen.findByRole("dialog", { name: "Search everything" });
    const box = within(sheet).getByRole("combobox", { name: "Search everything" });
    await waitFor(() => expect(box).toHaveFocus());
    await user.type(box, "cho");
    await user.click(await within(sheet).findByRole("option", { name: /Chore log/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl2");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search everything" })).not.toBeInTheDocument());
  });
});

describe("Highlight", () => {
  it("marks each match, counting code points so an emoji before a match does not shift it", () => {
    const { container } = render(
      <p>
        <Highlight text="🎉 Party party" matches={[{ start: 2, end: 7 }, { start: 8, end: 13 }]} />
      </p>,
    );
    expect(container.querySelector("p")).toHaveTextContent("🎉 Party party");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Party", "party"]);
  });

  it("leaves out ranges that do not fit the text, and shows the text alone without matches", () => {
    const { container } = render(
      <p>
        <Highlight text="Chores" matches={[{ start: 3, end: 2 }, { start: 4, end: 40 }]} />
        <Highlight text=" and more" matches={null} />
      </p>,
    );
    expect(container.querySelector("p")).toHaveTextContent("Chores and more");
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });
});

describe("where results matched", () => {
  it("highlights the name, and shows a record's matching field with its snippet", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const results: SearchResult[] = [
      { ...RESULTS[1]!, name_matches: [{ start: 0, end: 4 }] },
      {
        ...RESULTS[0]!,
        id: "rec2",
        record_id: "rec2",
        name: "Spring launch",
        snippet: "…and Steven will be in charge of marketing. That may…",
        snippet_matches: [{ start: 33, end: 37 }],
        field_name: "Notes",
      },
    ];
    searchApi(() => ({ results }));
    renderSearch();
    await user.type(screen.getByRole("combobox", { name: "Search everything" }), "mark");
    const record = await screen.findByRole("option", { name: /Spring launch/ });
    expect(record).toHaveTextContent("Notes: …and Steven will be in charge of marketing. That may…");
    expect([...record.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["mark"]);
    // Projects are listed before records.
    const project = screen.getAllByRole("option")[0]!;
    expect(project).toHaveTextContent("Chores");
    expect([...project.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Chor"]);
  });
});

describe("narrowing the search", () => {
  const WORKSPACES = [
    { id: "wsp1", name: "Household", color: "green", role: "owner", member_count: 1, pending_invite_count: 0, bases: [{ id: "app1", workspace_id: "wsp1", name: "Chores", color: "green", role: "owner", people: [] }] },
    { id: "wsp2", name: "Work", color: "blue", role: "owner", member_count: 1, pending_invite_count: 0, bases: [{ id: "app9", workspace_id: "wsp2", name: "Roadmap", color: "blue", role: "owner", people: [] }] },
  ] as unknown as WorkspaceSummary[];

  it("offers this project and this workspace once you type, and searches only there", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/workspaces": WORKSPACES,
      "GET /api/search": (call: RecordedCall) => ({ results: call.query.get("base") || call.query.get("workspace") === "wsp2" ? [] : RESULTS }),
    });
    renderWithProviders(<SearchEverything here={{ workspaceId: "wsp1", baseId: "app1" }} />);
    // Nothing to narrow before there is something to search for.
    expect(screen.queryByRole("group", { name: "Search in" })).not.toBeInTheDocument();
    const box = screen.getByRole("combobox", { name: "Search everything" });
    await user.type(box, "cho");
    const scopes = await screen.findByRole("group", { name: "Search in" });
    expect(within(scopes).getAllByRole("button").map((b) => b.textContent)).toEqual(["Everywhere", "This project", "This workspace"]);
    expect(within(scopes).getByRole("button", { name: "Everywhere" })).toHaveAttribute("aria-pressed", "true");
    await screen.findByRole("option", { name: /Take out trash/ });
    expect(api.callsTo("GET /api/search").at(-1)!.query.get("base")).toBeNull();

    await user.click(within(scopes).getByRole("button", { name: "This project" }));
    expect(within(scopes).getByRole("button", { name: "This project" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("No matches for “cho” in Chores")).toBeInTheDocument();
    expect(api.callsTo("GET /api/search").at(-1)!.query.get("base")).toBe("app1");
    // The click kept the box focused and the list open, so typing goes on.
    expect(box).toHaveFocus();

    // Any other workspace or project, from the picker.
    await user.selectOptions(within(scopes).getByRole("combobox", { name: "Search in a workspace or project" }), "All of Work");
    expect(await screen.findByText("No matches for “cho” in Work")).toBeInTheDocument();
    expect(api.callsTo("GET /api/search").at(-1)!.query.get("workspace")).toBe("wsp2");
    expect(within(scopes).getAllByRole("button").every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    await user.click(within(scopes).getByRole("button", { name: "Everywhere" }));
    await screen.findByRole("option", { name: /Take out trash/ });
  });

  it("offers only Everywhere and the picker on a page outside any workspace", async () => {
    stubDesktop();
    const user = userEvent.setup();
    mockApi({ "GET /api/workspaces": WORKSPACES, "GET /api/search": { results: RESULTS } });
    renderWithProviders(<SearchEverything />);
    await user.type(screen.getByRole("combobox", { name: "Search everything" }), "cho");
    const scopes = await screen.findByRole("group", { name: "Search in" });
    expect(within(scopes).getAllByRole("button").map((b) => b.textContent)).toEqual(["Everywhere"]);
    expect(await within(scopes).findByRole("combobox", { name: "Search in a workspace or project" })).toBeInTheDocument();
  });
});

describe("folding into a button when the bar is crowded", () => {
  /** A ResizeObserver whose sizes the test sets: `resize(px)` reports a new width to every observer. */
  function stubResizes() {
    const callbacks = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
        observe() {
          callbacks.add(this.cb);
        }
        unobserve() {}
        disconnect() {
          callbacks.delete(this.cb);
        }
      },
    );
    return (width: number) =>
      act(() => {
        for (const cb of [...callbacks]) cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      });
  }

  it("decides with some slack, so the box does not flicker at the edge", () => {
    expect(searchFits(true, SEARCH_FIELD_MIN)).toBe(true);
    expect(searchFits(true, SEARCH_FIELD_MIN - 1)).toBe(false);
    // Folded, the slot also has the button's room to give back, but needs a little more than the minimum.
    expect(searchFits(false, SEARCH_FIELD_MIN - SEARCH_BUTTON_ROOM)).toBe(false);
    expect(searchFits(false, SEARCH_FIELD_MIN)).toBe(true);
  });

  it("is a box while there is room, a button at the end when there is not, and ⌘K opens either", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const resize = stubResizes();
    searchApi();
    renderSearch();
    resize(600);
    expect(screen.getByRole("combobox", { name: "Search everything" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search everything" })).not.toBeInTheDocument();

    resize(150);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Search everything" });
    // A little more room is not enough to come back...
    resize(SEARCH_FIELD_MIN - SEARCH_BUTTON_ROOM + 10);
    expect(screen.getByRole("button", { name: "Search everything" })).toBe(button);

    // ...and while folded, ⌘K opens the same search in a box by the button.
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Search everything" });
    const box = within(dialog).getByRole("combobox", { name: "Search everything" });
    await waitFor(() => expect(box).toHaveFocus());
    await user.type(box, "cho");
    await user.click(await within(dialog).findByRole("option", { name: /Chore log/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl2");

    // Room again: the box is back in the bar, and ⌘K goes to it.
    resize(500);
    const inBar = screen.getByRole("combobox", { name: "Search everything" });
    expect(screen.queryByRole("button", { name: "Search everything" })).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(inBar).toHaveFocus();
  });

  it("leaves ⌘K to an editor that took it first", async () => {
    stubDesktop();
    const user = userEvent.setup();
    searchApi();
    renderWithProviders(
      <>
        <SearchEverything />
        <textarea aria-label="Editor" onKeyDown={(e) => e.key === "k" && e.preventDefault()} />
      </>,
    );
    await user.click(screen.getByRole("textbox", { name: "Editor" }));
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("textbox", { name: "Editor" })).toHaveFocus();
  });
});
