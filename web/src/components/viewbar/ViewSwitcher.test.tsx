import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Providers, createQueryClient } from "@/providers";
import { makeSchema, makeView } from "@/test/utils";
import { ViewSwitcher } from "./ViewSwitcher";

function setup(activeId: string) {
  const schema = makeSchema("creator");
  const t = schema.tables[0]!;
  const table = { ...t, views: [makeView({ id: "viwD", name: "Default grid", is_default: true }), makeView({ id: "viwA", name: "All tasks" }), makeView({ id: "viwB", name: "Board", type: "kanban" })] };
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
});
