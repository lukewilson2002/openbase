import { useLocation } from "react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/api/types";
import { apiError, mockApi, renderWithProviders, stubDesktop, type RecordedCall } from "@/test/utils";
import { SearchEverything, searchResultHref, searchResultPath } from "./SearchEverything";

afterEach(() => vi.unstubAllGlobals());

const where = { workspace_id: "wsp1", workspace_name: "Household", workspace_color: "green" };
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
    expect(groups.map((g) => g.getAttribute("aria-labelledby") && document.getElementById(g.getAttribute("aria-labelledby")!)!.textContent)).toEqual(["Workspaces", "Bases", "Tables", "Views", "Records"]);
    expect(within(list).getByRole("option", { name: /Take out trash/ })).toHaveTextContent("Household › Chores › Chores · every Tuesday");
    expect(box).toHaveAttribute("aria-expanded", "true");
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
