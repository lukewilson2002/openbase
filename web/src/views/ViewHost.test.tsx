import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BaseSchema, Table, View } from "@/api/types";
import { ViewHost } from "./ViewHost";

// Every view type is this one component, which keeps a draft in its own state.
const { Draft } = vi.hoisted(() => ({
  Draft: function Draft({ view }: { view: { name: string } }) {
    const [text, setText] = React.useState("");
    return <input aria-label={`Draft of ${view.name}`} value={text} onChange={(e) => setText(e.target.value)} />;
  },
}));
vi.mock("./registry", () => ({ getViewComponent: () => Draft }));

const view = (id: string): View => ({ id, table_id: "tbl1", name: id, type: "form", config: {} as never, personal: false, locked: false, is_default: false });
const schema = { id: "app1", role: "creator" } as BaseSchema;
const table = { id: "tbl1" } as Table;

describe("the view host", () => {
  it("starts the next view fresh when moving between two views of one type", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ViewHost schema={schema} table={table} view={view("a")} />);
    await user.type(await screen.findByLabelText("Draft of a"), "half done");
    rerender(<ViewHost schema={schema} table={table} view={view("b")} />);
    expect(await screen.findByLabelText("Draft of b")).toHaveValue("");
    // The same view keeps what was typed when only its config changes.
    await user.type(screen.getByLabelText("Draft of b"), "x");
    rerender(<ViewHost schema={schema} table={table} view={{ ...view("b"), name: "b" }} />);
    expect(screen.getByLabelText("Draft of b")).toHaveValue("x");
  });
});
