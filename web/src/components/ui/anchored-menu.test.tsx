import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AnchoredMenu } from "./anchored-menu";
import { DropdownMenuItem } from "./dropdown-menu";

function Harness({ onSelect }: { onSelect?: () => void }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  return (
    <>
      <button onClick={() => setAnchor({ x: 10, y: 10, width: 1, height: 1 })}>Surface</button>
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} label="Menu">
        <DropdownMenuItem onSelect={onSelect}>Do it</DropdownMenuItem>
      </AnchoredMenu>
    </>
  );
}

describe("AnchoredMenu", () => {
  it("gives focus back to what had it when the menu opened", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const surface = screen.getByRole("button", { name: "Surface" });
    await user.click(surface);
    await screen.findByRole("menu", { name: "Menu" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(surface).toHaveFocus();
  });

  it("gives focus back after an item is chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const surface = screen.getByRole("button", { name: "Surface" });
    await user.click(surface);
    await user.click(await screen.findByRole("menuitem", { name: "Do it" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(surface).toHaveFocus();
  });
});
