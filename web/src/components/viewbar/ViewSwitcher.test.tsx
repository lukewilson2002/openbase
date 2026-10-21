import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { View } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { makeSchema, makeView } from "@/test/utils";
import { ViewSwitcher, groupViews } from "./ViewSwitcher";

/** Where the switcher has taken the page. */
function Location() {
  return <output aria-label="Location">{useLocation().pathname}</output>;
}

function setup(activeId: string, { role = "creator", views }: { role?: string; views?: View[] } = {}) {
  const schema = makeSchema(role);
  const t = schema.tables[0]!;
  const table = { ...t, views: views ?? [makeView({ id: "viwD", name: "Grid", is_default: true }), makeView({ id: "viwA", name: "All tasks" }), makeView({ id: "viwB", name: "Board", type: "kanban" })] };
  render(
    <Providers client={createQueryClient()}>
      <MemoryRouter>
        <ViewSwitcher schema={{ ...schema, tables: [table] }} table={table} view={table.views.find((v) => v.id === activeId)!} />
        <Location />
      </MemoryRouter>
    </Providers>,
  );
}

describe("ViewSwitcher", () => {
  it("lists the default grid first, then a line, then the views without it", async () => {
    setup("viwA");
    await userEvent.click(screen.getByRole("button", { name: "View: All tasks" }));
    const menu = await screen.findByRole("menu", { name: "Views of Tasks" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => [i.textContent, i.getAttribute("href")])).toEqual([
      ["Default grid", "/base/app1/tbl1/viwD"],
      ["All tasks", "/base/app1/tbl1/viwA"],
      ["Board", "/base/app1/tbl1/viwB"],
    ]);
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[1]).toHaveAttribute("aria-current", "page");
    // The line sits between the default grid and the views.
    const line = within(menu).getByRole("separator");
    expect(items[0]!.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(items[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names the default grid on the button when it is open", async () => {
    setup("viwD");
    await userEvent.click(screen.getByRole("button", { name: "View: Default grid" }));
    expect(within(await screen.findByRole("menu", { name: "Views of Tasks" })).getByRole("menuitem", { name: "Default grid" })).toHaveAttribute("aria-current", "page");
  });

  it("has no line when the table has no views but its default grid", async () => {
    setup("viwD", { views: [makeView({ id: "viwD", name: "Grid", is_default: true })] });
    await userEvent.click(screen.getByRole("button", { name: "View: Default grid" }));
    expect(within(await screen.findByRole("menu", { name: "Views of Tasks" })).queryByRole("separator")).not.toBeInTheDocument();
  });

  it("groups views by type, the types in the order of their first view", () => {
    const views = [makeView({ id: "a", type: "kanban" }), makeView({ id: "b" }), makeView({ id: "c", type: "kanban" })];
    expect(groupViews(views).map((g) => [g.type, g.views.map((v) => v.id)])).toEqual([
      ["kanban", ["a", "c"]],
      ["grid", ["b"]],
    ]);
  });

  describe("a row shared by several views of one type", () => {
    const views = [makeView({ id: "viwD", name: "Grid", is_default: true }), makeView({ id: "viwA", name: "All tasks" }), makeView({ id: "viwB", name: "Board", type: "kanban" }), makeView({ id: "viwC", name: "Mine" })];
    const openRow = async () => {
      setup("viwB", { views });
      await userEvent.click(screen.getByRole("button", { name: "View: Board" }));
      return within(await screen.findByRole("menu", { name: "Views of Tasks" })).getByRole("menuitem", { name: "Grid views: All tasks and 1 more" });
    };

    it("opens the view it names on a click, and closes the list", async () => {
      await userEvent.click(await openRow());
      expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("/base/app1/tbl1/viwA");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    });

    it("opens the view it names on Enter", async () => {
      (await openRow()).focus();
      await userEvent.keyboard("{Enter}");
      expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("/base/app1/tbl1/viwA");
    });

    it("opens its views from its +1 end, staying where it is", async () => {
      const row = await openRow();
      const more = row.querySelector<HTMLElement>("[data-more]")!;
      vi.spyOn(more, "getBoundingClientRect").mockReturnValue({ x: 200, y: 0, left: 200, top: 0, width: 24, height: 18, right: 224, bottom: 18, toJSON: () => ({}) } as DOMRect);
      fireEvent.click(more, { clientX: 210, clientY: 9 });
      const sub = await screen.findByRole("menu", { name: "Grid views" });
      expect(within(sub).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["All tasks", "Mine"]);
      expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("/");
      expect(screen.getByRole("status", { name: "Location" })).not.toHaveTextContent("viwA");
    });
  });
});
