import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "./holdToDrag";
import { useHoldMenu } from "./holdMenu";

function Card({ open, onClick = () => {}, enabled = true }: { open: (a: { x: number; y: number }) => void; onClick?: () => void; enabled?: boolean }) {
  const hold = useHoldMenu(open, enabled);
  return (
    <div role="button" aria-label="Card" onClick={onClick} {...hold}>
      <a href="#x">link</a>
      <span data-no-hold>tick</span>
    </div>
  );
}

const at = (x = 100, y = 100, pointerType = "touch") => ({ pointerType, pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });
const card = () => screen.getByRole("button", { name: "Card" });
const hold = (ms = TOUCH_HOLD_MS) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useHoldMenu", () => {
  it("opens the menu where the finger was when a hold lets go without moving", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.pointerDown(card(), at());
    hold();
    expect(open).not.toHaveBeenCalled();
    fireEvent.pointerUp(card(), at());
    // A moment after the lift, so the click of a still press lands on the card and not on the sheet.
    expect(open).not.toHaveBeenCalled();
    hold(100);
    expect(open).toHaveBeenCalledWith({ x: 100, y: 100, width: 1, height: 1 });
  });

  it("swallows the click that follows the hold, so the press does not also open the record", () => {
    const click = vi.fn();
    render(<Card open={vi.fn()} onClick={click} />);
    fireEvent.pointerDown(card(), at());
    hold();
    fireEvent.pointerUp(card(), at());
    fireEvent.click(card());
    expect(click).not.toHaveBeenCalled();
    hold(100);
    // The swallowing is for that one click.
    fireEvent.click(card());
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a tap that lifts before the hold is up", () => {
    const open = vi.fn();
    const click = vi.fn();
    render(<Card open={open} onClick={click} />);
    fireEvent.pointerDown(card(), at());
    hold(TOUCH_HOLD_MS - 50);
    fireEvent.pointerUp(card(), at());
    fireEvent.click(card());
    hold(500);
    expect(open).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a hold that then moves: that is the drag, and a swipe before the hold is a scroll", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.pointerDown(card(), at());
    hold();
    fireEvent.pointerMove(card(), at(100, 100 + TOUCH_HOLD_TOLERANCE_PX + 4));
    fireEvent.pointerUp(card(), at(100, 140));
    hold(500);
    expect(open).not.toHaveBeenCalled();

    fireEvent.pointerDown(card(), at());
    fireEvent.pointerMove(card(), at(100, 130));
    hold();
    fireEvent.pointerUp(card(), at(100, 130));
    hold(500);
    expect(open).not.toHaveBeenCalled();
  });

  it("lets a small drift during the hold count as still", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.pointerDown(card(), at());
    fireEvent.pointerMove(card(), at(103, 102));
    hold();
    fireEvent.pointerUp(card(), at(103, 102));
    hold(100);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the browser takes the touch over for a scroll", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.pointerDown(card(), at());
    hold();
    fireEvent.pointerCancel(card(), at());
    hold(500);
    expect(open).not.toHaveBeenCalled();
  });

  it("reads Android's long-press contextmenu as the hold, and opens once at the lift", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.pointerDown(card(), at());
    hold(500);
    fireEvent.contextMenu(card(), { clientX: 100, clientY: 100 });
    expect(open).not.toHaveBeenCalled();
    fireEvent.pointerUp(card(), at());
    hold(100);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens even when the browser ends a long press with a cancel after contextmenu, unless the finger had moved", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.pointerDown(card(), at());
    hold(500);
    fireEvent.contextMenu(card(), { clientX: 100, clientY: 100 });
    fireEvent.pointerCancel(card(), at());
    hold(100);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens at the pointer for a right-click and at the card for the menu key", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.contextMenu(card(), { clientX: 30, clientY: 40 });
    expect(open).toHaveBeenLastCalledWith({ x: 30, y: 40, width: 1, height: 1 });
    fireEvent.contextMenu(card(), { clientX: 0, clientY: 0 });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("leaves a mouse press alone and a link or marked control to itself", () => {
    const open = vi.fn();
    render(<Card open={open} />);
    fireEvent.pointerDown(card(), at(100, 100, "mouse"));
    hold();
    fireEvent.pointerUp(card(), at(100, 100, "mouse"));
    fireEvent.pointerDown(screen.getByText("link"), at());
    hold();
    fireEvent.pointerUp(screen.getByText("link"), at());
    fireEvent.pointerDown(screen.getByText("tick"), at());
    hold();
    fireEvent.pointerUp(screen.getByText("tick"), at());
    hold(500);
    expect(open).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByText("link"));
    expect(open).not.toHaveBeenCalled();
  });

  it("is off for a row with no menu", () => {
    const open = vi.fn();
    render(<Card open={open} enabled={false} />);
    fireEvent.pointerDown(card(), at());
    hold();
    fireEvent.pointerUp(card(), at());
    fireEvent.contextMenu(card());
    hold(500);
    expect(open).not.toHaveBeenCalled();
  });
});
