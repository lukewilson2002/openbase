import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HelpTip } from "./help-tip";

const words = "Write something down and file it later.";

describe("HelpTip", () => {
  it("shows its words on a tap, and they stay until a tap elsewhere", async () => {
    const user = userEvent.setup();
    render(
      <>
        <HelpTip label="About the Inbox">{words}</HelpTip>
        <button type="button">Elsewhere</button>
      </>,
    );
    expect(screen.queryByText(words)).not.toBeInTheDocument();
    fireEvent.pointerEnter(screen.getByRole("button", { name: "About the Inbox" }), { pointerType: "touch" });
    expect(screen.queryByText(words)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "About the Inbox" }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await waitFor(() => expect(screen.queryByText(words)).not.toBeInTheDocument());
  });

  it("shows its words while a mouse rests on it, and a click there keeps them", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="About the Inbox">{words}</HelpTip>);
    const button = screen.getByRole("button", { name: "About the Inbox" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(await screen.findByText(words)).toBeInTheDocument();
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByText(words)).not.toBeInTheDocument());

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    await screen.findByText(words);
    await user.click(button);
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByText(words)).toBeInTheDocument();
  });

  it("keeps 12 px of room around its words (the menu surface under a popover pads 6)", async () => {
    render(<HelpTip label="About the Inbox">{words}</HelpTip>);
    await userEvent.click(screen.getByRole("button", { name: "About the Inbox" }));
    const panel = (await screen.findByText(words)).closest("[data-state]") as HTMLElement;
    expect(panel).toHaveClass("p-3");
    expect(panel).not.toHaveClass("p-1.5");
  });
});
