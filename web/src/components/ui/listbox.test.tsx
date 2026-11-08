import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ListboxOption } from "./listbox";

describe("ListboxOption", () => {
  it("keeps focus in the field above it when pressed, and selects on a click", async () => {
    const onSelect = vi.fn();
    render(
      <>
        <input aria-label="Search" />
        <div role="listbox" aria-label="Results">
          <ListboxOption id="o1" active={false} onSelect={onSelect}>
            Ada
          </ListboxOption>
        </div>
      </>,
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Search" }));
    await userEvent.click(screen.getByRole("option", { name: "Ada" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Search" })).toHaveFocus();
  });

  it("marks the highlighted row, in the soft accent fill", () => {
    render(
      <div role="listbox" aria-label="Results">
        <ListboxOption id="o1" active onSelect={() => {}}>
          Ada
        </ListboxOption>
        <ListboxOption id="o2" active={false} onSelect={() => {}}>
          Grace
        </ListboxOption>
      </div>,
    );
    expect(screen.getByRole("option", { name: "Ada" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("option", { name: "Ada" })).toHaveClass("data-[active=true]:bg-primary-soft");
    expect(screen.getByRole("option", { name: "Grace" })).toHaveAttribute("data-active", "false");
  });

  it("lets a rich row wrap and grow instead of cutting its content to one line", () => {
    render(
      <div role="listbox" aria-label="Results">
        <ListboxOption id="o1" active={false} rich onSelect={() => {}}>
          <span data-testid="summary">A name, a description and some labels</span>
        </ListboxOption>
        <ListboxOption id="o2" active={false} onSelect={() => {}}>
          Plain
        </ListboxOption>
      </div>,
    );
    const rich = screen.getByTestId("summary").parentElement!;
    expect(rich).not.toHaveClass("truncate");
    expect(screen.getByRole("option", { name: /A name/ })).toHaveClass("h-auto");
    expect(screen.getByText("Plain")).toHaveClass("truncate");
  });
});
