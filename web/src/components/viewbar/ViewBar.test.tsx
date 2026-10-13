import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { makeSchema, makeView } from "@/test/utils";
import { ViewBar, type ViewBarProps } from "./ViewBar";

const name = { ...ALL_FIELDS.single_line_text, id: "fld_name", name: "Name" };
const table = makeTable([name]);

function renderBar(over: Partial<ViewBarProps> = {}) {
  const view = over.view ?? makeView({ id: "viw1" });
  const props: ViewBarProps = {
    schema: makeSchema("viewer"),
    table,
    view,
    role: "viewer",
    config: view.config,
    canConfigure: false,
    hasLocalQuery: false,
    onResetLocalQuery: vi.fn(),
    saving: false,
    update: vi.fn(),
    collaborators: [],
    currentUserId: null,
    search: "",
    onSearchChange: vi.fn(),
    searchOpen: false,
    onSearchOpenChange: vi.fn(),
    searchInputRef: createRef<HTMLInputElement>(),
    onAddField: vi.fn(),
    canManageFields: false,
    ...over,
  };
  render(
    <Providers client={createQueryClient()}>
      <ViewBar {...props} />
    </Providers>,
  );
  return props;
}

describe("ViewBar for people who cannot save the view", () => {
  it("lets them filter, and says it applies only to them", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    expect(screen.getByText(/apply only to you and are not saved/)).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add condition" });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(props.update).toHaveBeenCalledTimes(1);
  });

  it("lets them sort and group too", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: /Sort/ }));
    expect(screen.getByText(/apply only to you and are not saved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add (a )?sort/i })).toBeEnabled();
  });

  it("keeps colours read-only (the override does not cover them)", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: /Color/ }));
    expect(screen.getByRole("group", { name: "Color records" })).toBeDisabled();
  });

  it("shows no Not saved marker while nothing local is in effect", () => {
    renderBar({ hasLocalQuery: false });
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
  });

  it("the Not saved marker resets the local query", async () => {
    const props = renderBar({ hasLocalQuery: true });
    expect(screen.getByRole("status")).toHaveTextContent("Not saved");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onResetLocalQuery).toHaveBeenCalledTimes(1);
  });
});

describe("ViewBar for people who can save the view", () => {
  it("shows no marker and no read-only note", async () => {
    renderBar({ canConfigure: true, hasLocalQuery: true, role: "editor", schema: makeSchema("editor") });
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument();
  });

  it("shows the locked badge on a locked view", () => {
    renderBar({ view: makeView({ id: "viw1", locked: true }), canConfigure: false });
    expect(screen.getByText("Locked")).toBeInTheDocument();
  });
});
