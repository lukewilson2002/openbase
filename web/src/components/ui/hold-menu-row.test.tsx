import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubPhone } from "@/test/utils";
import { TOUCH_HOLD_MS } from "@/lib/holdToDrag";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { HoldMenuRow } from "./hold-menu-row";

function Rows({ onRename = () => {} }: { onRename?: () => void }) {
  return (
    <ul>
      <HoldMenuRow aria-label="Welcome email">
        {(menu) => (
          <>
            <span>Welcome email</span>
            <DropdownMenu title="Welcome email" open={menu.open} onOpenChange={menu.onOpenChange}>
              <DropdownMenuTrigger asChild>
                <button aria-label="Options for Welcome email">…</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </HoldMenuRow>
    </ul>
  );
}

const at = (x = 40, y = 40) => ({ pointerType: "touch", pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("HoldMenuRow (PH-6)", () => {
  it("takes a hold on the row's own link, and the click that ends it does not follow the link", () => {
    stubPhone();
    const onLink = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <ul>
        <HoldMenuRow aria-label="Weekly digest">
          {(menu) => (
            <>
              <a href="/automations/aut1" data-hold-ok onClick={onLink}>
                Weekly digest
              </a>
              <a href="/elsewhere">Docs</a>
              <DropdownMenu title="Weekly digest" open={menu.open} onOpenChange={menu.onOpenChange}>
                <DropdownMenuTrigger asChild>
                  <button aria-label="Options for Weekly digest">…</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem>Rename</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </HoldMenuRow>
      </ul>,
    );
    // Another link in the row keeps its own tap.
    const docs = screen.getByRole("link", { name: "Docs" });
    fireEvent.pointerDown(docs, at());
    act(() => void vi.advanceTimersByTime(TOUCH_HOLD_MS));
    fireEvent.pointerUp(docs, at());
    act(() => void vi.advanceTimersByTime(100));
    expect(screen.queryByRole("dialog")).toBeNull();

    const link = screen.getByRole("link", { name: "Weekly digest" });
    fireEvent.pointerDown(link, at());
    act(() => void vi.advanceTimersByTime(TOUCH_HOLD_MS));
    fireEvent.pointerUp(link, at());
    fireEvent.click(link);
    act(() => void vi.advanceTimersByTime(100));
    expect(screen.getByRole("dialog", { name: "Weekly digest" })).toBeInTheDocument();
    expect(onLink).not.toHaveBeenCalled();
  });

  it("opens the row's menu, a bottom sheet on a phone, when a finger holds the row without moving", () => {
    stubPhone();
    const onRename = vi.fn();
    render(<Rows onRename={onRename} />);
    const row = screen.getByRole("listitem", { name: "Welcome email" });
    fireEvent.pointerDown(row, at());
    act(() => void vi.advanceTimersByTime(TOUCH_HOLD_MS));
    fireEvent.pointerUp(row, at());
    act(() => void vi.advanceTimersByTime(100));
    expect(screen.getByRole("dialog", { name: "Welcome email" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRename).toHaveBeenCalled();
  });

  it("does not open for a tap, or for a finger that moves (a scroll)", () => {
    stubPhone();
    render(<Rows />);
    const row = screen.getByRole("listitem", { name: "Welcome email" });
    fireEvent.pointerDown(row, at());
    act(() => void vi.advanceTimersByTime(TOUCH_HOLD_MS - 100));
    fireEvent.pointerUp(row, at());
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.pointerDown(row, at());
    fireEvent.pointerMove(row, at(40, 120));
    act(() => void vi.advanceTimersByTime(TOUCH_HOLD_MS + 200));
    fireEvent.pointerUp(row, at(40, 120));
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves a mouse alone: the right-click and the hold are for touch screens, the button is the mouse's way in", () => {
    render(<Rows />);
    const row = screen.getByRole("listitem", { name: "Welcome email" });
    fireEvent.contextMenu(row);
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
