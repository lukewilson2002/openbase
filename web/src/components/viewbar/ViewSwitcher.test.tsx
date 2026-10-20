import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { View } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { makeSchema, makeView, mockApi } from "@/test/utils";
import { ViewSwitcher } from "./ViewSwitcher";

function setup(activeId: string, { role = "creator", views }: { role?: string; views?: View[] } = {}) {
  const schema = makeSchema(role);
  const t = schema.tables[0]!;
  const table = { ...t, views: views ?? [makeView({ id: "viwD", name: "Default grid", is_default: true }), makeView({ id: "viwA", name: "All tasks" }), makeView({ id: "viwB", name: "Board", type: "kanban" })] };
  render(
    <Providers client={createQueryClient()}>
      <MemoryRouter>
        <ViewSwitcher schema={{ ...schema, tables: [table] }} table={table} view={table.views.find((v) => v.id === activeId)!} />
      </MemoryRouter>
    </Providers>,
  );
}

describe("ViewSwitcher", () => {
  it("puts the default grid first, on its own, and lists the views after it without it", () => {
    setup("viwA");
    const defaultGrid = screen.getByRole("link", { name: "Default grid" });
    expect(defaultGrid).toHaveAttribute("href", "/base/app1/tbl1/viwD");
    expect(defaultGrid).not.toHaveAttribute("aria-current");
    const views = screen.getByRole("navigation", { name: "Views of Tasks" });
    // Not grouped with the grid views, nor listed among them.
    expect(within(views).queryByRole("link", { name: "Default grid" })).toBeNull();
    expect(within(views).getByRole("link", { name: "All tasks" })).toHaveAttribute("aria-current", "page");
    // It comes before the views in the toolbar.
    expect(defaultGrid.compareDocumentPosition(views) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks the default grid when it is open", () => {
    setup("viwD");
    expect(screen.getByRole("link", { name: "Default grid" })).toHaveAttribute("aria-current", "page");
  });

  describe("putting the views in order", () => {
    afterEach(() => vi.restoreAllMocks());

    /** Room for every name (jsdom has no layout; with no media query the toolbar is a phone's). */
    const namesFit = () => {
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(200);
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    };
    const names = () => within(screen.getByRole("navigation", { name: "Views of Tasks" })).getAllByRole("link").map((l) => l.getAttribute("aria-label"));

    it("drags a view's button along the toolbar: the new order is sent and shown, and the drop opens nothing", async () => {
      namesFit();
      // The buttons side by side, 100px apart.
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const i = Array.from(document.querySelectorAll("a[data-sortable]")).indexOf(this as HTMLAnchorElement);
        const left = i < 0 ? 0 : i * 100;
        return { x: left, y: 0, left, top: 0, width: 100, height: 36, right: left + 100, bottom: 36, toJSON: () => ({}) } as DOMRect;
      });
      const api = mockApi({ "POST /api/tables/tbl1/views/reorder": { ok: true }, "GET /api/bases/app1": { status: 500 } });
      setup("viwA");
      expect(names()).toEqual(["All tasks", "Board"]);
      const board = screen.getByRole("link", { name: "Board" });
      expect(board).toHaveAttribute("data-sortable");
      fireEvent.mouseDown(board, { button: 0, clientX: 150, clientY: 18 });
      for (const x of [140, 100, 60, 40]) {
        fireEvent.mouseMove(document, { clientX: x, clientY: 18 });
        await act(async () => {});
      }
      expect(board).toHaveAttribute("data-dragging");
      fireEvent.mouseUp(document, { clientX: 40, clientY: 18 });
      // Shown in the new order at once (the app's schema then follows from the cache).
      expect(names()).toEqual(["Board", "All tasks"]);
      // The click a browser sends after the release would otherwise follow the link.
      expect(fireEvent.click(board)).toBe(false);
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views/reorder")).toHaveLength(1));
      expect(api.callsTo("POST /api/tables/tbl1/views/reorder")[0]?.body).toEqual({ ids: ["viwB", "viwA"] });
    });

    it("cannot be dragged by an editor while shared views are shown, nor once the buttons are icons", () => {
      namesFit();
      setup("viwA", { role: "editor" });
      expect(document.querySelector("[data-sortable]")).toBeNull();
    });

    it("can be dragged by an editor whose views are all personal", () => {
      namesFit();
      setup("viwA", {
        role: "editor",
        views: [makeView({ id: "viwD", name: "Default grid", is_default: true }), makeView({ id: "viwA", name: "Mine", personal: true }), makeView({ id: "viwB", name: "Also mine", personal: true })],
      });
      expect(document.querySelectorAll("a[data-sortable]")).toHaveLength(2);
    });

    it("has no drag while views of one type share an icon", () => {
      setup("viwA");
      expect(document.querySelector("[data-sortable]")).toBeNull();
    });
  });
});
