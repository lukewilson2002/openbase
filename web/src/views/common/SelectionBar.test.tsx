import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stubDesktop, stubPhone } from "@/test/utils";
import { SelectionBar } from "./SelectionBar";

function bar(extra?: { children?: boolean }) {
  const props = { count: 3, onDuplicate: vi.fn(), onDelete: vi.fn(), onClear: vi.fn() };
  render(<SelectionBar {...props}>{extra?.children ? <button type="button">Move to</button> : null}</SelectionBar>);
  return props;
}

describe("SelectionBar", () => {
  it("is a bar of buttons on a desktop", async () => {
    stubDesktop();
    const props = bar({ children: true });
    const toolbar = within(screen.getByRole("toolbar", { name: "Selected records" }));
    expect(toolbar.getByText("3 selected")).toBeInTheDocument();
    expect(toolbar.getByRole("button", { name: "Move to" })).toBeInTheDocument();
    await userEvent.setup().click(toolbar.getByRole("button", { name: "Duplicate" }));
    expect(props.onDuplicate).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(toolbar.getByRole("button", { name: "Delete" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(toolbar.getByRole("button", { name: /^Clear selection/ }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("is the count and Actions on a phone, and the actions are in a sheet that closes after one", async () => {
    stubPhone();
    const user = userEvent.setup();
    const props = bar();
    const toolbar = within(screen.getByRole("toolbar", { name: "Selected records" }));
    expect(toolbar.queryByRole("button", { name: "Duplicate" })).not.toBeInTheDocument();
    const actions = toolbar.getByRole("button", { name: "Actions" });
    await user.click(actions);
    let sheet = within(await screen.findByRole("dialog", { name: "3 selected" }));
    await user.click(sheet.getByRole("button", { name: "Duplicate" }));
    expect(props.onDuplicate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(actions);
    sheet = within(await screen.findByRole("dialog", { name: "3 selected" }));
    await user.click(sheet.getByRole("button", { name: "Delete" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    // The way to let go stays in the bar, one tap away.
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(toolbar.getByRole("button", { name: "Clear selection" }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("keeps every target in the phone bar at 44 px", () => {
    stubPhone();
    bar();
    const toolbar = screen.getByRole("toolbar", { name: "Selected records" });
    expect(within(toolbar).getByRole("button", { name: "Actions" }).className).toContain("max-md:h-control-touch");
    expect(within(toolbar).getByRole("button", { name: "Clear selection" }).className).toMatch(/control-touch|size-11|min-h-11|h-11/);
  });
});
