import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NameDialog } from "@/components/NameDialog";
import { IconPicker, IconPickerDialog } from "./IconPicker";
import { resetIconRegistryForTests } from "./registry";
import { fakeIconSet, gatedImporter } from "./testSet";

let gate: ReturnType<typeof gatedImporter>;
const set = fakeIconSet(300);

beforeEach(() => {
  gate = gatedImporter(set);
  resetIconRegistryForTests(gate.importer);
});
afterEach(() => resetIconRegistryForTests());

async function open(props: Partial<React.ComponentProps<typeof IconPicker>> = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<IconPicker onChange={onChange} {...props} />);
  await user.click(screen.getByRole("button", { name: /icon$/i }));
  return { user, onChange };
}

async function loaded() {
  await act(async () => gate.release());
  return screen.findByRole("group", { name: "All icons" });
}

describe("IconPicker", () => {
  it("loads nothing until it opens, then shows the 20 popular icons before the full list has loaded", async () => {
    await open();
    const popular = await screen.findByRole("group", { name: "Popular icons" });
    const buttons = within(popular).getAllByRole("button");
    expect(buttons).toHaveLength(20);
    expect(buttons.map((b) => b.getAttribute("aria-label")).slice(0, 4)).toEqual(["Briefcase", "Users", "House", "Building"]);
    // the full set is requested as the picker opens, and is still on its way
    await waitFor(() => expect(gate.calls.count).toBe(1));
    expect(await screen.findByText("Loading all icons…")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search icons" })).toBeInTheDocument();
    await loaded();
    expect(screen.queryByText("Loading all icons…")).not.toBeInTheDocument();
  });

  it("does not load the full set while closed", () => {
    render(<IconPicker onChange={() => {}} />);
    expect(gate.calls.count).toBe(0);
  });

  it("picks a popular icon and closes", async () => {
    const { user, onChange } = await open();
    const popular = await screen.findByRole("group", { name: "Popular icons" });
    await user.click(within(popular).getByRole("button", { name: "Truck" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("truck");
    await waitFor(() => expect(screen.queryByRole("searchbox")).not.toBeInTheDocument());
  });

  it("lists the whole set in a window, not all at once, and scrolls through it", async () => {
    await open();
    const list = await loaded();
    const initially = within(list).getAllByRole("button");
    expect(initially.length).toBeGreaterThan(30);
    expect(initially.length).toBeLessThan(set.names.length / 2);
    const last = set.names[set.names.length - 1]!;
    expect(within(list).queryByRole("button", { name: new RegExp(`^${last.replace(/-/g, " ")}$`, "i") })).not.toBeInTheDocument();
    const rows = Math.ceil(set.names.length / 10);
    fireEvent.scroll(list, { target: { scrollTop: (rows - 1) * 34 } });
    expect(await within(list).findByRole("button", { name: new RegExp(`^${last.replace(/-/g, " ")}$`, "i") })).toBeInTheDocument();
  });

  it("filters by name as you type (debounced) and hides the popular section", async () => {
    const { user } = await open();
    await loaded();
    await user.type(screen.getByRole("searchbox", { name: "Search icons" }), "cart");
    const results = await screen.findByRole("group", { name: "Matching icons" });
    expect(within(results).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Shopping cart"]);
    expect(screen.queryByRole("group", { name: "Popular icons" })).not.toBeInTheDocument();
    expect(screen.getByText("1 icon")).toBeInTheDocument();
  });

  it("finds icons by alias too", async () => {
    const { user } = await open();
    await loaded();
    await user.type(screen.getByRole("searchbox", { name: "Search icons" }), "home");
    const results = await screen.findByRole("group", { name: "Matching icons" });
    expect(within(results).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["House"]);
  });

  it("says when nothing matches, and returns to the full list when the search is cleared", async () => {
    const { user } = await open();
    await loaded();
    const search = screen.getByRole("searchbox", { name: "Search icons" });
    await user.type(search, "qqqq");
    expect(await screen.findByText("No icons match “qqqq”")).toBeInTheDocument();
    await user.clear(search);
    expect(await screen.findByRole("group", { name: "Popular icons" })).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "All icons" })).toBeInTheDocument();
  });

  it("searches the popular icons while the rest is still loading", async () => {
    const { user } = await open();
    await user.type(screen.getByRole("searchbox", { name: "Search icons" }), "truck");
    const results = await screen.findByRole("group", { name: "Matching icons" });
    expect(within(results).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Truck"]);
  });

  it("picks the best match with Enter in the search box, without waiting for the debounce", async () => {
    const { user, onChange } = await open();
    await loaded();
    await user.type(screen.getByRole("searchbox", { name: "Search icons" }), "pie{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("chart-pie");
  });

  it("does nothing on Enter when there is no search or no match", async () => {
    const { user, onChange } = await open();
    await loaded();
    const search = screen.getByRole("searchbox", { name: "Search icons" });
    await user.type(search, "{Enter}");
    await user.type(search, "qqqq{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves through the grid with the arrow keys and picks with Enter", async () => {
    const { user, onChange } = await open();
    await loaded();
    const label = () => document.activeElement?.getAttribute("aria-label");
    expect(screen.getByRole("searchbox", { name: "Search icons" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(label()).toBe("Briefcase");
    await user.keyboard("{ArrowRight}");
    expect(label()).toBe("Users");
    await user.keyboard("{ArrowDown}"); // one row down: column 1 of the second row
    expect(label()).toBe("File text");
    await user.keyboard("{ArrowLeft}");
    expect(label()).toBe("List checks");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("searchbox", { name: "Search icons" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(label()).toBe("List checks");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("list-checks");
  });

  it("keeps one tab stop in the grid (roving tabindex)", async () => {
    await open();
    await loaded();
    const popular = screen.getByRole("group", { name: "Popular icons" });
    const stops = within(popular)
      .getAllByRole("button")
      .filter((b) => b.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  it("walks from the popular icons into the full list and to its end with the keyboard", async () => {
    const { user } = await open();
    const list = await loaded();
    const label = () => document.activeElement?.getAttribute("aria-label");
    await user.keyboard("{ArrowDown}"); // first popular
    await user.keyboard("{ArrowDown}{ArrowDown}"); // two rows down: first row of the list
    expect(list.contains(document.activeElement)).toBe(true);
    expect(label()).toBe(within(list).getAllByRole("button")[0]!.getAttribute("aria-label"));
    await user.keyboard("{Control>}{End}{/Control}");
    await waitFor(() => expect(label()).toBe("Zap"));
    await user.keyboard("{Control>}{Home}{/Control}");
    await waitFor(() => expect(label()).toBe("Briefcase"));
  });

  it("marks the current icon and offers Remove icon only when there is one", async () => {
    const { user, onChange } = await open({ value: "heart" });
    const popular = await screen.findByRole("group", { name: "Popular icons" });
    expect(within(popular).getByRole("button", { name: "Heart" })).toHaveAttribute("aria-pressed", "true");
    expect(within(popular).getByRole("button", { name: "Star" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Remove icon" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("has no Remove icon without an icon", async () => {
    await open({ value: null });
    await screen.findByRole("group", { name: "Popular icons" });
    expect(screen.queryByRole("button", { name: "Remove icon" })).not.toBeInTheDocument();
  });

  it("focuses the search box on open with a mouse, as a popover", async () => {
    await open();
    expect(await screen.findByRole("searchbox", { name: "Search icons" })).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Icon picker" })).toBeInTheDocument();
    expect(screen.queryByTestId("icon-picker-backdrop")).not.toBeInTheDocument();
  });

  it("closes on Escape without changing anything", async () => {
    const { user, onChange } = await open();
    await screen.findByRole("searchbox", { name: "Search icons" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("searchbox")).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers Try again when the full list cannot be loaded, and loads it on retry", async () => {
    let attempts = 0;
    resetIconRegistryForTests(async () => {
      attempts++;
      if (attempts === 1) throw new Error("offline");
      return { fullIconSet: set };
    });
    const { user } = await open();
    expect(await screen.findByText("The full icon list could not be loaded.")).toBeInTheDocument();
    // the popular icons still work
    expect(within(screen.getByRole("group", { name: "Popular icons" })).getAllByRole("button")).toHaveLength(20);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("group", { name: "All icons" })).toBeInTheDocument();
  });

  it("can be disabled, and can wrap your own trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<IconPicker onChange={onChange} disabled />);
    expect(screen.getByRole("button", { name: "Choose icon" })).toBeDisabled();
    rerender(
      <IconPicker onChange={onChange}>
        <button type="button">My trigger</button>
      </IconPicker>,
    );
    await user.click(screen.getByRole("button", { name: "My trigger" }));
    expect(await screen.findByRole("group", { name: "Popular icons" })).toBeInTheDocument();
  });
});

describe("IconPickerDialog", () => {
  it("shows the same picker in a dialog and reports the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    render(<IconPickerDialog open onOpenChange={onOpenChange} title="Table icon" value="star" onChange={onChange} />);
    const dialog = await screen.findByRole("dialog", { name: "Table icon" });
    await user.click(await within(dialog).findByRole("button", { name: "Target" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("target");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

/** A phone: `(pointer: coarse)` matches (and so does any query that lists it). */
function touchScreen() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: /pointer:\s*coarse/.test(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

/** A finger lifting where it went down, with no click after it (what iOS Safari does on the backdrop). */
function tap(el: Element, moveBy = 0) {
  fireEvent.touchStart(el, { touches: [{ clientX: 20, clientY: 20 }], changedTouches: [{ clientX: 20, clientY: 20 }] });
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: 20, clientY: 20 + moveBy }] });
}

describe("IconPicker on a touch screen", () => {
  beforeEach(touchScreen);
  afterEach(() => vi.restoreAllMocks());

  it("opens as a sheet without focusing the search box, so the keyboard stays down", async () => {
    const { user } = await open();
    const sheet = await screen.findByRole("dialog", { name: "Choose icon" });
    await loaded();
    expect(sheet).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "Search icons" })).not.toHaveFocus();
    expect(within(sheet).getByRole("group", { name: "Popular icons" })).toBeInTheDocument();
    await user.click(screen.getByRole("searchbox", { name: "Search icons" }));
    expect(screen.getByRole("searchbox", { name: "Search icons" })).toHaveFocus();
  });

  it("closes on a tap on the backdrop, without a click event, and returns focus to the trigger", async () => {
    const { onChange } = await open();
    await screen.findByRole("dialog", { name: "Choose icon" });
    tap(screen.getByTestId("icon-picker-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose icon" })).toHaveFocus();
  });

  it("stays open when a swipe ends on the backdrop", async () => {
    await open();
    await screen.findByRole("dialog", { name: "Choose icon" });
    tap(screen.getByTestId("icon-picker-backdrop"), 60);
    expect(screen.getByRole("dialog", { name: "Choose icon" })).toBeInTheDocument();
  });

  it("closes and reports the icon when one is chosen", async () => {
    const { user, onChange } = await open();
    const sheet = await screen.findByRole("dialog", { name: "Choose icon" });
    await user.click(within(sheet).getByRole("button", { name: "Truck" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("truck");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes on Escape and with the close button", async () => {
    const { user, onChange } = await open();
    await screen.findByRole("dialog", { name: "Choose icon" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Choose icon" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Choose icon" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("inside the name dialog: a tap outside or Escape closes only the picker, and the chosen icon is kept", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    render(<NameDialog open onOpenChange={onOpenChange} title="New workspace" submitLabel="Create workspace" withIcon onSubmit={onSubmit} />);
    const nameDialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(within(nameDialog).getByRole("textbox", { name: "Name" }), "Kitchen");
    await user.click(within(nameDialog).getByRole("button", { name: "Choose icon" }));
    await screen.findByRole("dialog", { name: "Choose icon" });
    tap(screen.getByTestId("icon-picker-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose icon" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose icon" }));
    await screen.findByRole("dialog", { name: "Choose icon" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose icon" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose icon" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Choose icon" })).getByRole("button", { name: "Truck" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose icon" })).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Kitchen", "truck");
  });

  it("shows the menu's icon dialog as a sheet too", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    render(<IconPickerDialog open onOpenChange={onOpenChange} title="Table icon" value="star" onChange={onChange} />);
    const sheet = await screen.findByRole("dialog", { name: "Table icon" });
    expect(screen.getByTestId("icon-picker-backdrop")).toBeInTheDocument();
    await loaded();
    expect(screen.getByRole("searchbox", { name: "Search icons" })).not.toHaveFocus();
    await user.click(within(sheet).getByRole("button", { name: "Target" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("target");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
