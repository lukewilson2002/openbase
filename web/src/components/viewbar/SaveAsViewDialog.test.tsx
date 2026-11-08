import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stubDesktop } from "@/test/utils";
import { SaveAsViewDialog } from "./SaveAsViewDialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Save as view
      </button>
      <SaveAsViewDialog open={open} onOpenChange={setOpen} initialName="Done only" canShareWithEveryone={false} onSave={vi.fn()} />
    </>
  );
}

describe("SaveAsViewDialog", () => {
  it("puts focus in the name, and Escape gives it back to the button that opened the dialog", async () => {
    stubDesktop();
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Save as view" });
    await user.click(opener);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
