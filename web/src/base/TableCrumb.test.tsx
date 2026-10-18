import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSchema, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { TableCrumb } from "./TableCrumb";

afterEach(() => vi.unstubAllGlobals());

describe("TableCrumb", () => {
  it("names the table, and a creator changes its icon with a tap on it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const schema = makeSchema("creator");
    const table = schema.tables[0]!;
    const api = mockApi({ "PATCH /api/tables/tbl1": (c) => ({ ...table, ...(c.body as object) }) });
    renderWithProviders(<TableCrumb schema={schema} table={table} />);
    expect(screen.getByRole("heading", { name: "Tasks", level: 2 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change the icon of Tasks" }));
    await user.click(within(await screen.findByRole("group", { name: "Popular icons" })).getByRole("button", { name: "Briefcase" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1").map((c) => c.body)).toEqual([{ icon: "briefcase" }]));
  });

  it("shows the icon without a button to those who cannot manage tables", () => {
    const schema = makeSchema("editor");
    renderWithProviders(<TableCrumb schema={schema} table={schema.tables[0]!} />);
    expect(screen.getByRole("heading", { name: "Tasks", level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change the icon of Tasks" })).not.toBeInTheDocument();
  });
});
