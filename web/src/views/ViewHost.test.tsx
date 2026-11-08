import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BaseSchema, Table, View } from "@/api/types";
import { keys } from "@/api/keys";
import { Providers, createQueryClient } from "@/providers";
import { USER } from "@/test/utils";
import { writeDraft } from "./drafts/store";
import { ViewHost } from "./ViewHost";

// Every view type is this one component, which keeps a draft in its own state.
const { Draft } = vi.hoisted(() => ({
  Draft: function Draft({ view }: { view: { name: string } }) {
    const [text, setText] = React.useState("");
    return <input aria-label={`Draft of ${view.name}`} value={text} onChange={(e) => setText(e.target.value)} />;
  },
}));
vi.mock("./registry", () => ({
  getViewComponent: (type: string) =>
    type === "kanban"
      ? function Board({ view }: { view: { type: string; name: string } }) {
          return <p>Board of {view.name}, saved as {view.type}</p>;
        }
      : Draft,
}));

const view = (id: string): View => ({ id, table_id: "tbl1", name: id, type: "form", config: {} as never, personal: false, locked: false, is_default: false });
const schema = { id: "app1", role: "creator" } as BaseSchema;
const table = { id: "tbl1" } as Table;

describe("the view host", () => {
  it("starts the next view fresh when moving between two views of one type", async () => {
    const user = userEvent.setup();
    const client = createQueryClient();
    client.setQueryData(keys.me, USER);
    const host = (v: View) => (
      <Providers client={client}>
        <ViewHost schema={schema} table={table} view={v} />
      </Providers>
    );
    const { rerender } = render(host(view("a")));
    await user.type(await screen.findByLabelText("Draft of a"), "half done");
    rerender(host(view("b")));
    expect(await screen.findByLabelText("Draft of b")).toHaveValue("");
    // The same view keeps what was typed when only its config changes.
    await user.type(screen.getByLabelText("Draft of b"), "x");
    rerender(host({ ...view("b"), name: "b" }));
    expect(screen.getByLabelText("Draft of b")).toHaveValue("x");
  });

  it("shows the layout this person's draft switched to, and hands it the saved view", async () => {
    const client = createQueryClient();
    client.setQueryData(keys.me, USER);
    writeDraft("usr1", "a", { v: 1, base: "x", started: 1, layout: "kanban", changes: {} });
    render(
      <Providers client={client}>
        <ViewHost schema={schema} table={table} view={view("a")} />
      </Providers>,
    );
    expect(await screen.findByText("Board of a, saved as form")).toBeInTheDocument();
    // Another view keeps its own layout.
    expect(screen.queryByLabelText("Draft of a")).not.toBeInTheDocument();
  });
});
