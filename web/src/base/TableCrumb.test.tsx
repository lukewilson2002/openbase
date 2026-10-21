import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeSchema, renderWithProviders } from "@/test/utils";
import { TableCrumb } from "./TableCrumb";

describe("TableCrumb", () => {
  it("names the open table, bold and in the accent colour, without an icon", () => {
    const table = makeSchema("creator").tables[0]!;
    renderWithProviders(<TableCrumb table={table} />);
    const heading = screen.getByRole("heading", { name: "Tasks", level: 2 });
    expect(heading).toHaveClass("font-semibold", "text-primary-text");
    expect(heading.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
