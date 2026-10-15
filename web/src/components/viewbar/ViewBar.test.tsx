import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { makeSchema, makeView, stubDesktop } from "@/test/utils";
import { TOOLS_KEY, ViewBar, type ViewBarProps } from "./ViewBar";

const name = { ...ALL_FIELDS.single_line_text, id: "fld_name", name: "Name" };
const table = makeTable([name]);

/** `keepStorage` leaves the tools' remembered state alone; otherwise they start unfolded. */
function renderBar(over: Partial<ViewBarProps> = {}, { keepStorage = false } = {}) {
  // jsdom matches no media query (a phone, where the tools start folded); most tests want them out.
  if (!keepStorage) localStorage.setItem(TOOLS_KEY, "0");
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
  const { unmount } = render(
    <Providers client={createQueryClient()}>
      <ViewBar {...props} />
    </Providers>,
  );
  return { ...props, unmount };
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

describe("ViewBar sharing and export", () => {
  it("offers Download CSV to everyone who can see the view", () => {
    renderBar();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
  });

  it("can leave the CSV button out (form views)", () => {
    renderBar({ features: { csv: false } });
    expect(screen.queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument();
  });

  it.each(["viewer", "commenter", "editor"])("hides Share view from a %s", (role) => {
    renderBar({ role });
    expect(screen.queryByRole("button", { name: "Share view" })).not.toBeInTheDocument();
  });

  it("opens the share dialog for a creator", async () => {
    renderBar({ role: "creator", schema: makeSchema("creator") });
    await userEvent.click(screen.getByRole("button", { name: "Share view" }));
    expect(await screen.findByRole("dialog", { name: /^Share / })).toBeInTheDocument();
  });

  it("disables Share view on a personal view and says why", () => {
    renderBar({ role: "creator", schema: makeSchema("creator"), view: makeView({ id: "viw1", personal: true }) });
    const button = screen.getByRole("button", { name: "Share view" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Personal views cannot be shared");
  });
});

describe("ViewBar tools", () => {
  it("folds the tools into one button that counts the active ones, and remembers the choice", async () => {
    const user = userEvent.setup();
    const view = makeView({ id: "viw1", config: { ...makeView({ id: "viw1" }).config, sorts: [{ field_id: "fld_name", direction: "asc" }], filter: { conjunction: "and", items: [{ field_id: "fld_name", op: "contains", value: "a" }] } } });
    const { unmount } = renderBar({ view, config: view.config });
    expect(screen.getByRole("button", { name: /^Filter|1 filter/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide tools" }));
    expect(screen.queryByRole("button", { name: /1 filter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sorted by/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tools · 2 on" })).toBeInTheDocument();
    expect(localStorage.getItem(TOOLS_KEY)).toBe("1");

    // A new page view starts folded, and unfolding is remembered too.
    unmount();
    renderBar({ view, config: view.config }, { keepStorage: true });
    await user.click(screen.getByRole("button", { name: "Tools · 2 on" }));
    expect(screen.getByRole("button", { name: /Sorted by 1 field/ })).toBeInTheDocument();
    expect(localStorage.getItem(TOOLS_KEY)).toBe("0");
  });

  it("starts folded on a phone and unfolded on a desktop until a choice is made", () => {
    const phone = renderBar({}, { keepStorage: true });
    expect(screen.getByRole("button", { name: "Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Filter/ })).not.toBeInTheDocument();
    phone.unmount();
    stubDesktop();
    renderBar({}, { keepStorage: true });
    expect(screen.getByRole("button", { name: /^Filter/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tools" })).not.toBeInTheDocument();
  });
});

describe("ViewBar Add", () => {
  it("adds a record from the toolbar on a desktop", async () => {
    stubDesktop();
    const onAdd = vi.fn();
    renderBar({ onAdd });
    const add = screen.getByRole("button", { name: "Add record" });
    expect(add).toHaveTextContent("Add");
    expect(add.closest("[role=toolbar]")).not.toBeNull();
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("floats at the bottom corner on a phone", async () => {
    const onAdd = vi.fn();
    renderBar({ onAdd });
    const add = screen.getByRole("button", { name: "Add record" });
    expect(add).toHaveClass("fixed");
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("is left out when there is no way to add", () => {
    stubDesktop();
    renderBar();
    expect(screen.queryByRole("button", { name: "Add record" })).not.toBeInTheDocument();
  });
});
