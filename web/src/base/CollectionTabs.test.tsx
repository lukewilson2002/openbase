import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseSchema, Table, View } from "@/api/types";
import { makeSchema, makeView, mockApi, renderWithProviders, stubDesktop, stubPhone } from "@/test/utils";
import { BaseDialogContext, type BaseDialog } from "./BaseDialogs";
import { CollectionTabs } from "./CollectionTabs";

afterEach(() => vi.restoreAllMocks());

/** Where the app is: choosing a tab goes to its address (BaseShell then shows the view it names). */
function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

/** Clients with its default view, two shared views and a personal one, as the server lists them (the default last). */
function clients(role: string, over: Partial<Table> = {}): { schema: BaseSchema; table: Table; views: Record<string, View> } {
  const schema = makeSchema(role);
  const views = {
    all: makeView({ id: "viwD", name: "Grid", is_default: true }),
    open: makeView({ id: "viwA", name: "Open deals" }),
    board: makeView({ id: "viwB", name: "Pipeline", type: "kanban" }),
    mine: makeView({ id: "viwC", name: "Mine", personal: true }),
    frozen: makeView({ id: "viwF", name: "Frozen", locked: true }),
  };
  const table: Table = { ...schema.tables[0]!, name: "Clients", views: [views.open, views.board, views.mine, views.frozen, views.all], ...over };
  return { schema: { ...schema, tables: [table] }, table, views };
}

function renderTabs(role: string, open = "viwD", { phone = false, onDialog = vi.fn<(dialog: BaseDialog) => void>(), over }: { phone?: boolean; onDialog?: (dialog: BaseDialog) => void; over?: Partial<Table> } = {}) {
  if (phone) stubPhone();
  else stubDesktop();
  const { schema, table, views } = clients(role, over);
  const view = table.views.find((v) => v.id === open)!;
  const { unmount } = renderWithProviders(
    <BaseDialogContext.Provider value={onDialog}>
      <CollectionTabs schema={schema} table={table} view={view} />
      <Where />
    </BaseDialogContext.Provider>,
    `/base/app1/tbl1/${open}`,
  );
  return { schema, table, views, onDialog, unmount };
}

const tab = (name: string | RegExp) => screen.getByRole("tab", { name });
const names = () => screen.getAllByRole("tab").map((t) => t.textContent);

describe("view tabs", () => {
  it("start with the default view, reading All and the collection's name, then the saved views with their layout icons", () => {
    renderTabs("viewer");
    expect(names()).toEqual(["All clients", "Open deals", "Pipeline", "Mine", "Frozen"]);
    expect(screen.getByRole("tablist", { name: "Views of Clients" })).toBeInTheDocument();
    // The default view is simply every record: no layout icon. A saved view has its layout's.
    expect(tab("All clients").querySelector("svg")).toBeNull();
    expect(tab("Pipeline").querySelector("svg")).not.toBeNull();
  });

  it("mark the open view, a personal view with a person glyph and a locked one with a lock", () => {
    renderTabs("viewer", "viwB");
    expect(tab("Pipeline")).toHaveAttribute("aria-selected", "true");
    expect(tab("All clients")).toHaveAttribute("aria-selected", "false");
    expect(within(tab(/^Mine/)).getByRole("img", { name: "Personal view" })).toBeInTheDocument();
    expect(within(tab(/^Frozen/)).getByRole("img", { name: "Locked view" })).toBeInTheDocument();
    expect(within(tab("Open deals")).queryByRole("img")).not.toBeInTheDocument();
  });

  it("have no + tab and no Add view, for any role", () => {
    for (const role of ["viewer", "editor", "creator", "owner"]) {
      const { unmount } = renderTabs(role);
      expect(screen.queryByRole("button", { name: /add|new|\+/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /add|new|\+/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("open a view when it is chosen", async () => {
    const user = userEvent.setup();
    renderTabs("viewer");
    await user.click(tab("Pipeline"));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viwB");
    // Enter on a focused tab chooses it too (the arrows only move).
    tab("Open deals").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viwA");
    // Choosing the open view goes nowhere.
    await user.click(tab("All clients"));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viwA");
  });
});

describe("view tabs that do not fit", () => {
  /** Every tab 120 px wide in a row of `row` px, as a browser would lay it out. */
  function layout(row: number, tab = 120) {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(row);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(tab);
  }

  it("go into a More menu from the right, and the menu opens them", async () => {
    layout(420);
    const user = userEvent.setup();
    renderTabs("viewer");
    // 5 tabs of 124 do not fit in 420; More keeps 88 of it: two tabs stay.
    expect(names()).toEqual(["All clients", "Open deals"]);
    await user.click(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Pipeline", "Mine", "Frozen"]);
    await user.click(within(menu).getByRole("menuitem", { name: /^Frozen/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viwF");
  });

  it("keep the open view on the strip, in the place of the last tab that fits", () => {
    layout(420);
    renderTabs("viewer", "viwF");
    expect(names()).toEqual(["All clients", "Frozen"]);
    expect(tab(/^Frozen/)).toHaveAttribute("aria-selected", "true");
  });

  it("have no More when they all fit", () => {
    layout(1000);
    renderTabs("viewer");
    expect(names()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("show the More menu as a sheet on a phone", async () => {
    layout(300);
    const user = userEvent.setup();
    renderTabs("viewer", "viwD", { phone: true });
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More views" });
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent?.trim())).toContain("Frozen");
  });
});

describe("a view tab's menu", () => {
  /** Right-clicks the tab; the menu is named for the view, which is the tab's name unless the tab carries glyphs. */
  const rightClick = async (name: string | RegExp, label = String(name)) => {
    fireEvent.contextMenu(tab(name), { clientX: 50, clientY: 40 });
    return screen.findByRole("menu", { name: `Options for ${label}` });
  };
  const items = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim());

  it("holds rename, duplicate, share, lock, move and delete for a creator, on a right-click", async () => {
    renderTabs("creator");
    const menu = await rightClick("Pipeline");
    expect(items(menu)).toEqual(["Rename view", "Duplicate view", "Share view…", "Lock view", "Move left", "Move right", "Delete view"]);
    // Open deals is the first of the shared views, so it cannot go further left.
    const first = await (async () => {
      await userEvent.keyboard("{Escape}");
      return rightClick("Open deals");
    })();
    expect(within(await first).getByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    expect(within(await first).getByRole("menuitem", { name: "Move right" })).not.toHaveAttribute("aria-disabled");
  });

  it("offers Unlock on a locked view", async () => {
    renderTabs("creator");
    const menu = await rightClick(/^Frozen/, "Frozen");
    expect(items(menu)).toContain("Unlock view");
  });

  it("has none on the default view, which can be neither renamed, locked nor deleted", () => {
    renderTabs("owner");
    expect(fireEvent.contextMenu(tab("All clients"))).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the dialogs for rename, delete and share", async () => {
    const user = userEvent.setup();
    const { onDialog, views } = renderTabs("creator");
    await user.click(within(await rightClick("Pipeline")).getByRole("menuitem", { name: "Rename view" }));
    expect(onDialog).toHaveBeenLastCalledWith({ kind: "rename-view", view: views.board });
    await user.click(within(await rightClick("Pipeline")).getByRole("menuitem", { name: "Delete view" }));
    expect(onDialog).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "delete-view", view: views.board }));
    await user.click(within(await rightClick("Pipeline")).getByRole("menuitem", { name: "Share view…" }));
    expect(onDialog).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "share", view: views.board, tab: "view" }));
  });

  it("moves a shared view among the shared ones with Move left and Move right, leaving the personal one out", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "POST /api/tables/tbl1/views/reorder": { ok: true } });
    renderTabs("creator");
    await user.click(within(await rightClick("Pipeline")).getByRole("menuitem", { name: "Move left" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views/reorder")).toHaveLength(1));
    // The shared views Open deals, Pipeline and Frozen; the personal view Mine is not among them.
    expect(api.callsTo("POST /api/tables/tbl1/views/reorder")[0]?.body).toEqual({ ids: ["viwB", "viwA", "viwF"] });
  });

  it("has no Move for a lone personal view: the shared views are not its neighbours", async () => {
    renderTabs("editor", "viwC");
    const menu = await rightClick(/^Mine/, "Mine");
    expect(within(menu).queryByRole("menuitem", { name: /^Move/ })).not.toBeInTheDocument();
  });

  it("is a creator's for shared views: an editor gets one on their personal view only, a viewer on none", async () => {
    const { unmount } = renderTabs("editor", "viwC");
    expect(fireEvent.contextMenu(tab("Pipeline"))).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const menu = await rightClick(/^Mine/, "Mine");
    expect(items(menu)).toEqual(["Rename view", "Duplicate view", "Delete view"]);
    await userEvent.keyboard("{Escape}");
    unmount();
    renderTabs("viewer");
    expect(fireEvent.contextMenu(tab("Open deals"))).toBe(true);
    expect(fireEvent.contextMenu(tab(/^Mine/))).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("is a bottom sheet on a phone, titled with the view", async () => {
    const user = userEvent.setup();
    const { onDialog, views } = renderTabs("creator", "viwD", { phone: true });
    fireEvent.contextMenu(tab("Pipeline"), { clientX: 50, clientY: 40 });
    const sheet = await screen.findByRole("dialog", { name: "Pipeline" });
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent?.trim()).filter((t) => t !== "Done")).toEqual(["Rename view", "Duplicate view", "Share view…", "Lock view", "Move left", "Move right", "Delete view"]);
    await user.click(within(sheet).getByRole("button", { name: "Rename view" }));
    expect(onDialog).toHaveBeenLastCalledWith({ kind: "rename-view", view: views.board });
  });
});

describe("dragging view tabs", () => {
  it("is for those who may reorder the views: shared ones for a creator, personal ones for an editor", () => {
    const { unmount } = renderTabs("creator");
    expect(tab("Open deals")).toHaveAttribute("data-sortable");
    expect(tab("Pipeline")).toHaveAttribute("data-sortable");
    // The default view never moves; the only personal view has no other to move among.
    expect(tab("All clients")).not.toHaveAttribute("data-sortable");
    expect(tab(/^Mine/)).not.toHaveAttribute("data-sortable");
    unmount();
    renderTabs("editor");
    expect(tab("Open deals")).not.toHaveAttribute("data-sortable");
    unmount();
    renderTabs("viewer");
    expect(document.querySelector("[data-sortable]")).toBeNull();
  });
});
