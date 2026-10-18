import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TOUCH_HOLD_TOLERANCE_PX } from "./holdToDrag";
import { useTapGuard } from "./tapGuard";

function Menu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button">Actions</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// By text: Radix hides everything outside an open menu from the accessibility tree.
const trigger = () => screen.getByText("Actions");
const opened = () => screen.queryByRole("menuitem", { name: "Rename" }) !== null;
const at = (x = 100, y = 100, pointerType = "touch") => ({ pointerType, pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });

/** A finger that goes down, optionally moves, and lifts; `click` is what a browser sends after a tap (and not after a scroll). */
function finger(el: Element, steps: { move?: [number, number]; cancel?: boolean; click?: boolean }) {
  fireEvent.pointerDown(el, at());
  if (steps.move) fireEvent.pointerMove(el, at(...steps.move));
  if (steps.cancel) fireEvent.pointerCancel(el, at());
  else fireEvent.pointerUp(el, at(...(steps.move ?? [100, 100])));
  if (steps.click) fireEvent.click(el);
}

describe("a menu trigger on a phone", () => {
  it("does not open on a touch pointerdown (it cancels it so Radix does not)", () => {
    render(<Menu />);
    const down = createEvent.pointerDown(trigger(), at());
    fireEvent(trigger(), down);
    expect(down.defaultPrevented).toBe(true);
    expect(opened()).toBe(false);
  });

  it("opens when the finger lifts in place and the click arrives", () => {
    render(<Menu />);
    finger(trigger(), { click: true });
    expect(opened()).toBe(true);
  });

  it("a tap on a trigger whose menu is open closes it again", () => {
    render(<Menu />);
    finger(trigger(), { click: true });
    expect(opened()).toBe(true);
    // Radix makes everything outside the open menu inert, so in the app the tap lands on its
    // overlay; here the toggle itself is under test.
    finger(trigger(), { click: true });
    expect(opened()).toBe(false);
  });

  it("a pen taps like a finger", () => {
    render(<Menu />);
    fireEvent.pointerDown(trigger(), at(100, 100, "pen"));
    fireEvent.pointerUp(trigger(), at(100, 100, "pen"));
    fireEvent.click(trigger());
    expect(opened()).toBe(true);
  });

  it("does not open when the finger moves past the tolerance", () => {
    render(<Menu />);
    finger(trigger(), { move: [100, 100 + TOUCH_HOLD_TOLERANCE_PX + 4], click: true });
    expect(opened()).toBe(false);
  });

  it("still opens when the finger drifts within the tolerance", () => {
    render(<Menu />);
    finger(trigger(), { move: [102, 103], click: true });
    expect(opened()).toBe(true);
  });

  it("does not open when the browser takes the touch over to scroll (pointercancel)", () => {
    render(<Menu />);
    finger(trigger(), { cancel: true, click: true });
    expect(opened()).toBe(false);
  });

  it("does not open without a click (a scroll sends none)", () => {
    render(<Menu />);
    finger(trigger(), {});
    expect(opened()).toBe(false);
  });

  it("a swipe does not leave the next tap blocked", () => {
    render(<Menu />);
    finger(trigger(), { cancel: true });
    finger(trigger(), { click: true });
    expect(opened()).toBe(true);
  });

  it("does not open a disabled trigger", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger disabled>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    finger(trigger(), { click: true });
    expect(opened()).toBe(false);
  });
});

describe("a menu trigger with a mouse or the keyboard", () => {
  it("opens on the mouse's pointerdown, as Radix does", () => {
    render(<Menu />);
    fireEvent.pointerDown(trigger(), at(100, 100, "mouse"));
    expect(opened()).toBe(true);
  });

  it("a mouse click does not toggle it closed again", async () => {
    render(<Menu />);
    await userEvent.click(trigger());
    expect(opened()).toBe(true);
  });

  it.each(["{Enter}", " ", "{ArrowDown}"])("opens with %j", async (key) => {
    render(<Menu />);
    trigger().focus();
    await userEvent.keyboard(key);
    expect(opened()).toBe(true);
  });
});

describe("useTapGuard", () => {
  function Probe({ onTap }: { onTap: () => void }) {
    const g = useTapGuard(onTap);
    return (
      <button type="button" {...g}>
        probe
      </button>
    );
  }

  it("calls onTap once for a clean tap and not for a second click with no press", () => {
    const onTap = vi.fn();
    render(<Probe onTap={onTap} />);
    const el = screen.getByRole("button");
    finger(el, { click: true });
    expect(onTap).toHaveBeenCalledOnce();
    fireEvent.click(el);
    expect(onTap).toHaveBeenCalledOnce();
  });

  it("ignores a mouse press and its click", () => {
    const onTap = vi.fn();
    render(<Probe onTap={onTap} />);
    const el = screen.getByRole("button");
    fireEvent.pointerDown(el, at(100, 100, "mouse"));
    fireEvent.pointerUp(el, at(100, 100, "mouse"));
    fireEvent.click(el);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("ignores moves of a different pointer", () => {
    const onTap = vi.fn();
    render(<Probe onTap={onTap} />);
    const el = screen.getByRole("button");
    fireEvent.pointerDown(el, at());
    fireEvent.pointerMove(el, { ...at(300, 300), pointerId: 2 });
    fireEvent.pointerUp(el, at());
    fireEvent.click(el);
    expect(onTap).toHaveBeenCalledOnce();
  });
});
