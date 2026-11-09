import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubDesktop, stubPhone } from "@/test/utils";
import { Button } from "./button";
import { CommandPalette, type CommandGroup } from "./command-palette";
import { ConfirmDialog } from "./confirm-dialog";
import { Dialog } from "./dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu";
import { FilterBar, type FilterBarChip, type FilterBarSuggestion } from "./filter-bar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Sheet, SheetActions } from "./sheet";
import { rubberBand, settleSheet, sheetSnapPoints } from "./sheet-snap";
import { SidePanel } from "./side-panel";
import { TemporaryChangesBar } from "./temporary-changes-bar";
import { ToastProvider, useToast, type ToastOptions } from "./toast";

describe("Popover", () => {
  // A pop-over on a desktop; a phone gets the sheet (see "Popover on a phone").
  beforeEach(() => stubDesktop());

  function Harness() {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button>Open</button>
        </PopoverTrigger>
        <PopoverContent aria-label="Options">
          <button>First</button>
        </PopoverContent>
      </Popover>
    );
  }

  it("is a surface with radius 12, the shadow and 6 px padding", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Options" })).toHaveClass("rounded-lg", "shadow-pop", "p-1.5", "bg-surface");
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe("SheetActions (PH-5)", () => {
  it("sticks to the foot of a sheet's body, which itself rides above the keyboard", async () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: { height: window.innerHeight - 250, offsetTop: 0, addEventListener: () => {}, removeEventListener: () => {} } });
    try {
      render(
        <Sheet open onOpenChange={() => {}} title="Set Status">
          <input aria-label="Value" />
          <SheetActions>
            <button>Set Status</button>
          </SheetActions>
        </Sheet>,
      );
      const sheet = await screen.findByRole("dialog", { name: "Set Status" });
      expect(sheet).toHaveStyle({ bottom: "250px" });
      expect(screen.getByRole("button", { name: "Set Status" }).parentElement).toHaveClass("max-md:sticky", "max-md:bottom-0");
    } finally {
      Reflect.deleteProperty(window, "visualViewport");
    }
  });
});

describe("Popover on a phone", () => {
  it("opens as a bottom sheet named for the popover, unless it opts out", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Popover title="Pick one">
          <PopoverTrigger asChild>
            <button>Open</button>
          </PopoverTrigger>
          <PopoverContent>
            <button>First</button>
          </PopoverContent>
        </Popover>
        <Popover sheet={false}>
          <PopoverTrigger asChild>
            <button>Help</button>
          </PopoverTrigger>
          <PopoverContent aria-label="Tip">Some help</PopoverContent>
        </Popover>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    const sheet = await screen.findByRole("dialog", { name: "Pick one" });
    expect(sheet).toHaveClass("rounded-t-xl");
    await user.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(await screen.findByRole("dialog", { name: "Tip" })).toHaveClass("rounded-lg", "shadow-pop");
  });
});

describe("Menu", () => {
  // A dropdown on a desktop; a phone gets the sheet (see "Menu on a phone").
  beforeEach(() => stubDesktop());

  function Harness({ onPick = () => {} }: { onPick?: (name: string) => void }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button>Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => onPick("Rename")}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPick("Duplicate")}>Duplicate</DropdownMenuItem>
          <DropdownMenuItem danger onSelect={() => onPick("Delete")}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("has 40 px rows on a surface with radius 12, 6 px padding and the shadow", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: "Actions" }).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveClass("rounded-lg", "p-1.5", "shadow-pop");
    for (const item of within(menu).getAllByRole("menuitem")) expect(item).toHaveClass("min-h-control-lg", "data-[highlighted]:bg-primary-soft", "rounded-md");
  });

  it("is driven by the arrow keys, highlights the row, and Enter picks it", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    screen.getByRole("button", { name: "Actions" }).focus();
    await user.keyboard("{Enter}");
    const items = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    expect(items[0]).toHaveAttribute("data-highlighted");
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    expect(items[1]).toHaveAttribute("data-highlighted");
    expect(items[0]).not.toHaveAttribute("data-highlighted");
    await user.keyboard("{End}");
    expect(items[2]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("Delete");
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Actions" });
    opener.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe("Menu on a phone", () => {
  function Harness({ onPick = () => {}, onTheme = () => {} }: { onPick?: (name: string) => void; onTheme?: (v: string) => void }) {
    return (
      <DropdownMenu title="Actions for Ada">
        <DropdownMenuTrigger asChild>
          <button>Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Ada</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onPick("Rename")}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={(e) => (e.preventDefault(), onPick("Keep open"))}>Keep open</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value="light" onValueChange={onTheme}>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuItem danger disabled>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("opens as a bottom sheet with 44 px rows instead of a dropdown (PH-3)", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onTheme = vi.fn();
    render(<Harness onPick={onPick} onTheme={onTheme} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Actions for Ada" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Rename" })).toHaveClass("min-h-control-touch");
    expect(within(sheet).getByRole("button", { name: "Light" })).toHaveAttribute("aria-current", "true");
    expect(within(sheet).getByRole("button", { name: "Delete" })).toBeDisabled();

    // A choice that keeps the menu open (preventDefault, as in a dropdown) leaves the sheet where it is.
    await user.click(within(sheet).getByRole("button", { name: "Keep open" }));
    expect(onPick).toHaveBeenCalledWith("Keep open");
    expect(screen.getByRole("dialog", { name: "Actions for Ada" })).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Dark" }));
    expect(onTheme).toHaveBeenCalledWith("dark");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes after an item acts and hands focus back to the button that opened it", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const opener = screen.getByRole("button", { name: "Actions" });
    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    expect(onPick).toHaveBeenCalledWith("Rename");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe("sheet resting points", () => {
  it("has full, half and closed for a tall sheet, and only full and closed for one that fits in half the screen", () => {
    expect(sheetSnapPoints(600, 800)).toEqual([0, 200, 600]);
    expect(sheetSnapPoints(300, 800)).toEqual([0, 300]);
    expect(sheetSnapPoints(0, 800)).toEqual([0]);
  });

  const points = [0, 200, 600];
  it("settles at the nearest point when let go slowly", () => {
    expect(settleSheet({ offset: 80, velocity: 0, points })).toBe(0);
    expect(settleSheet({ offset: 130, velocity: 0, points })).toBe(200);
    expect(settleSheet({ offset: 450, velocity: 0, points })).toBe(600);
  });

  it("uses the drag velocity: a flick goes on to the next point in its direction", () => {
    // Let go at the same place, going down fast or up fast.
    expect(settleSheet({ offset: 100, velocity: 2, points })).toBe(600);
    expect(settleSheet({ offset: 100, velocity: 0.5, points })).toBe(200);
    expect(settleSheet({ offset: 300, velocity: -1.5, points })).toBe(0);
  });

  it("gives a little above full and no more", () => {
    expect(rubberBand(50)).toBe(50);
    expect(rubberBand(-10)).toBe(-2);
    expect(rubberBand(-500)).toBe(-24);
  });
});

describe("Sheet", () => {
  function Harness({ onOpenChange = () => {} }: { onOpenChange?: (open: boolean) => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open sheet</button>
        <Sheet
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            onOpenChange(o);
          }}
          title="Sort"
        >
          <button>Soonest</button>
          <button>Latest</button>
        </Sheet>
      </>
    );
  }

  it("has a title, a Done button, a 36 x 5 grab handle and the overlay", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    const sheet = await screen.findByRole("dialog", { name: "Sort" });
    expect(sheet).toHaveClass("rounded-t-xl", "shadow-pop");
    expect(within(sheet).getByRole("button", { name: "Done" })).toBeInTheDocument();
    const handle = sheet.querySelector("[aria-hidden].rounded-pill");
    expect(handle).toHaveClass("h-1.25", "w-9");
    expect(document.querySelector(".bg-overlay")).toBeInTheDocument();
  });

  it("closes with Done", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole("button", { name: "Open sheet" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("traps focus inside, closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open sheet" });
    await user.click(opener);
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  describe("dragging", () => {
    /** Pointer events with a time we choose, because the velocity is read from the events' time stamps. */
    function pointer(target: Element, type: "pointerDown" | "pointerMove" | "pointerUp", clientY: number, t: number) {
      const ev = createEvent[type](target, { clientY, pointerId: 1, button: 0 });
      // Offset: React takes a time stamp of 0 for a missing one.
      Object.defineProperty(ev, "timeStamp", { value: 10_000 + t });
      fireEvent(target, ev);
    }

    async function openTall() {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
      const onOpenChange = vi.fn();
      render(<Harness onOpenChange={onOpenChange} />);
      await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
      const sheet = await screen.findByRole("dialog");
      return { sheet, zone: screen.getByTestId("sheet-drag-zone"), onOpenChange };
    }

    it("follows the finger while held", async () => {
      const { sheet, zone } = await openTall();
      pointer(zone, "pointerDown", 100, 0);
      pointer(zone, "pointerMove", 160, 30);
      expect(sheet.style.transform).toBe("translateY(60px)");
      expect(sheet.style.transition).toBe("none");
    });

    it("settles at half when let go slowly past the middle", async () => {
      const { sheet, zone, onOpenChange } = await openTall();
      pointer(zone, "pointerDown", 100, 0);
      pointer(zone, "pointerMove", 300, 900);
      pointer(zone, "pointerUp", 300, 1000);
      // The screen is 768 tall in jsdom: half of it leaves the 600 px sheet 600 - 384 = 216 down.
      expect(sheet.style.transform).toBe("translateY(216px)");
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("returns to full after a small pull", async () => {
      const { sheet, zone, onOpenChange } = await openTall();
      pointer(zone, "pointerDown", 100, 0);
      pointer(zone, "pointerMove", 120, 900);
      pointer(zone, "pointerUp", 120, 1000);
      expect(sheet.style.transform).toBe("");
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("closes on a fast flick down", async () => {
      const { zone, onOpenChange } = await openTall();
      pointer(zone, "pointerDown", 100, 0);
      pointer(zone, "pointerMove", 200, 40);
      pointer(zone, "pointerUp", 220, 60);
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });

    it("comes back when the owner refuses the close", async () => {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
      const onOpenChange = vi.fn();
      render(<Sheet open onOpenChange={onOpenChange} title="Delete Clients?" />);
      const sheet = await screen.findByRole("dialog");
      const zone = screen.getByTestId("sheet-drag-zone");
      pointer(zone, "pointerDown", 100, 0);
      pointer(zone, "pointerMove", 200, 40);
      pointer(zone, "pointerUp", 220, 60);
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(sheet.style.transform).toBe("");
    });

    it("leaves the Done button its own tap", async () => {
      const { sheet, zone } = await openTall();
      pointer(within(sheet).getByRole("button", { name: "Done" }), "pointerDown", 100, 0);
      pointer(zone, "pointerMove", 300, 30);
      expect(sheet.style.transform).toBe("");
    });
  });
});

describe("Dialog", () => {
  function Harness({ onOpenChange = () => {} }: { onOpenChange?: (open: boolean) => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open dialog</button>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            onOpenChange(o);
          }}
          title="Rename"
          footer={<Button>Save</Button>}
        >
          <input aria-label="Name" />
        </Dialog>
      </>
    );
  }

  it("is centered with radius 12 on a desktop", async () => {
    stubDesktop();
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    expect(dialog).toHaveClass("rounded-lg", "-translate-x-1/2", "-translate-y-1/2");
  });

  it("is a full-screen sheet below the desktop breakpoint", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    expect(dialog).toHaveClass("inset-x-0", "ob-sheet-in");
    expect(dialog).not.toHaveClass("-translate-x-1/2");
    expect(dialog.style.height).not.toBe("");
  });

  it.each([
    ["desktop", true],
    ["phone", false],
  ])("traps focus, closes on Escape and returns focus to the opener (%s)", async (_name, desktop) => {
    if (desktop) stubDesktop();
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe("returning focus when the content takes focus itself", () => {
  // An autoFocus field takes focus before Radix reports that the content opened, so the opener has to be noted earlier.
  it.each([
    ["Dialog on a desktop", true],
    ["Dialog on a phone", false],
  ])("%s returns focus to the opener when a field in it has autoFocus", async (_name, desktop) => {
    if (desktop) stubDesktop();
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open it</button>
          <Dialog open={open} onOpenChange={setOpen} title="Name it">
            <input aria-label="Name" autoFocus />
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);
    expect(await screen.findByLabelText("Name")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("Sheet returns focus to the opener when a field in it has autoFocus", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open it</button>
          <Sheet open={open} onOpenChange={setOpen} title="Pick one">
            {open && <input aria-label="Search" autoFocus />}
          </Sheet>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);
    expect(await screen.findByLabelText("Search")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe("ConfirmDialog", () => {
  function Harness({ onConfirm = () => {} }: { onConfirm?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Delete it</button>
        <ConfirmDialog open={open} onOpenChange={setOpen} title="Delete Clients?" description="Moves to the trash for 30 days." confirmLabel="Delete" destructive onConfirm={onConfirm} />
      </>
    );
  }

  it.each([
    ["desktop", true, "-translate-x-1/2"],
    ["phone", false, "rounded-t-xl"],
  ])("is an alert dialog (%s), a dialog on a desktop and a bottom sheet on a phone", async (_name, desktop, cls) => {
    if (desktop) stubDesktop();
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Clients?" });
    expect(dialog).toHaveClass(cls);
    expect(dialog).toHaveAccessibleDescription("Moves to the trash for 30 days.");
  });

  it("starts with focus on Cancel and closes on Escape, returning focus to the opener", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const opener = screen.getByRole("button", { name: "Delete it" });
    await user.click(opener);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("is not answered by a press outside it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Delete it" }));
    await screen.findByRole("alertdialog");
    await user.click(document.querySelector(".bg-overlay")!);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

describe("SidePanel", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Comments</button>
        <SidePanel open={open} onOpenChange={setOpen} title="Comments">
          <button>Reply</button>
        </SidePanel>
      </>
    );
  }

  it("is a 360 px panel named by its title", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Comments" }));
    const panel = screen.getByRole("complementary", { name: "Comments" });
    expect(panel).toHaveClass("w-panel");
    expect(readFileSync(resolve(process.cwd(), "src/styles/index.css"), "utf8")).toMatch(/--container-panel:\s*22\.5rem/);
  });

  it("takes focus on opening; Escape and the close button close it and give focus back", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Comments" });
    await user.click(opener);
    const panel = screen.getByRole("complementary");
    expect(panel).toHaveFocus();
    await user.tab();
    expect(panel.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Close comments" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("SidePanel opening by itself", () => {
  it("leaves the keyboard where it is when it is told not to take it, and is still named and closable", async () => {
    const user = userEvent.setup();
    function Remembered() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button>Page</button>
          <SidePanel open={open} onOpenChange={setOpen} title="Comments" focusOnOpen={false}>
            <button>Reply</button>
          </SidePanel>
        </>
      );
    }
    render(<Remembered />);
    const panel = screen.getByRole("complementary", { name: "Comments" });
    expect(panel).not.toHaveFocus();
    expect(panel.contains(document.activeElement)).toBe(false);
    await user.click(screen.getByRole("button", { name: "Close comments" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("Dialog with a flush body", () => {
  it("lays the body out as a column of the dialog's height with no padding of its own, full screen on a phone", async () => {
    stubPhone();
    render(
      <Dialog open onOpenChange={() => {}} title="Comments" flush>
        <p>Thread</p>
      </Dialog>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Comments" });
    expect(dialog).toHaveClass("inset-x-0");
    const body = screen.getByText("Thread").parentElement!;
    expect(body).toHaveClass("flex", "flex-col", "min-h-0", "flex-1");
    expect(body).not.toHaveClass("px-4", "py-4", "overflow-y-auto");
  });
});

const GROUPS = (onSelect: (id: string) => void): CommandGroup[] => [
  { id: "records", label: "Records", items: [{ id: "r1", label: "Acme renewal", hint: "Clients", onSelect: () => onSelect("r1") }, { id: "r2", label: "Beta kickoff", onSelect: () => onSelect("r2") }] },
  { id: "empty", label: "Folders", items: [] },
  { id: "actions", label: "Actions", items: [{ id: "a1", label: "New collection", onSelect: () => onSelect("a1") }] },
];

describe("CommandPalette", () => {
  function Harness({ onSelect = () => {}, groups = GROUPS(onSelect) }: { onSelect?: (id: string) => void; groups?: CommandGroup[] }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    return (
      <>
        <button onClick={() => setOpen(true)}>Search</button>
        <CommandPalette open={open} onOpenChange={setOpen} query={query} onQueryChange={setQuery} groups={groups} />
      </>
    );
  }

  async function openPalette() {
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "Search" });
    await user.click(opener);
    const input = await screen.findByRole("combobox", { name: "Search" });
    return { user, opener, input };
  }

  it("opens with focus in the field, groups the results and leaves empty groups out", async () => {
    render(<Harness />);
    const { input } = await openPalette();
    await waitFor(() => expect(input).toHaveFocus());
    const list = screen.getByRole("listbox", { name: "Results" });
    expect(within(list).getAllByRole("group")).toHaveLength(2);
    expect(within(list).getByRole("group", { name: "Records" })).toBeInTheDocument();
    expect(within(list).getByRole("group", { name: "Actions" })).toBeInTheDocument();
    expect(within(list).queryByText("Folders")).not.toBeInTheDocument();
    expect(within(list).getAllByRole("option")).toHaveLength(3);
  });

  it("highlights the first result, moves across groups with the arrows and wraps", async () => {
    render(<Harness />);
    const { user, input } = await openPalette();
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[2]!.id);
    await user.keyboard("{ArrowDown}");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveFocus();
  });

  it("runs the highlighted result on Enter and closes", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const { user } = await openPalette();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("r2");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("runs a result that is clicked", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const { user } = await openPalette();
    await user.click(screen.getByRole("option", { name: /New collection/ }));
    expect(onSelect).toHaveBeenCalledWith("a1");
  });

  it("closes on Escape and returns focus to the opener", async () => {
    render(<Harness />);
    const { user, opener } = await openPalette();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("says how many results there are in a polite live region, and when there are none", async () => {
    const { rerender } = render(<Harness />);
    await openPalette();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("3 results");
    rerender(<Harness groups={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("runs a command only after the palette has left, so what it opens does not stack under a fading palette", async () => {
    const seen: { dialogs: number }[] = [];
    const groups: CommandGroup[] = [{ id: "actions", label: "Actions", items: [{ id: "a1", label: "New collection", onSelect: () => seen.push({ dialogs: screen.queryAllByRole("dialog").length }) }] }];
    render(<Harness groups={groups} />);
    const { user, opener } = await openPalette();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ dialogs: 0 });
    expect(opener).toHaveFocus();
    // Escape runs nothing.
    await user.click(opener);
    await screen.findByRole("combobox", { name: "Search" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(seen).toHaveLength(1);
  });

  it("keeps Enter from running results that are for older text, while a click still does", async () => {
    const onSelect = vi.fn();
    const stale: CommandGroup[] = [{ id: "records", label: "Records", stale: true, items: [{ id: "r1", label: "Acme", onSelect: () => onSelect("r1") }] }];
    render(<Harness groups={stale} />);
    const { user } = await openPalette();
    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Search everything" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Acme" }));
    expect(onSelect).toHaveBeenCalledWith("r1");
  });

  it("shows a second line under a row, and says a failed search as an alert", async () => {
    const groups: CommandGroup[] = [{ id: "records", label: "Records", items: [{ id: "r1", label: "Acme", detail: "Notes: …renewal in May…", onSelect: () => {} }] }];
    function WithError() {
      const [open, setOpen] = useState(true);
      return <CommandPalette open={open} onOpenChange={setOpen} query="a" onQueryChange={() => {}} groups={groups} error="Search is unavailable: Database is busy" />;
    }
    render(<WithError />);
    expect(screen.getByRole("option", { name: /Acme/ })).toHaveTextContent("Notes: …renewal in May…");
    expect(screen.getByRole("alert")).toHaveTextContent("Search is unavailable: Database is busy");
    expect(screen.getByRole("status")).toHaveTextContent("Search is unavailable");
  });

  it("hands its field to the caller", async () => {
    let field: HTMLInputElement | null = null;
    function WithRef() {
      return <CommandPalette open onOpenChange={() => {}} query="" onQueryChange={() => {}} groups={[]} inputRef={(el) => void (el && (field = el))} />;
    }
    render(<WithRef />);
    expect(field).toBe(screen.getByRole("combobox", { name: "Search" }));
  });
});

describe("FilterBar", () => {
  const SUGGESTIONS: FilterBarSuggestion[] = [
    { id: "s1", label: "Status is Done" },
    { id: "s2", label: "Notes contain “done”" },
    { id: "s3", label: "Search every property for “done”" },
  ];

  function Harness({ initialChips = [], onApply = () => {}, advanced }: { initialChips?: FilterBarChip[]; onApply?: (s: FilterBarSuggestion) => void; advanced?: () => void }) {
    const [chips, setChips] = useState(initialChips);
    const [text, setText] = useState("");
    return (
      <FilterBar
        chips={chips}
        onRemoveChip={(id) => setChips((cur) => cur.filter((c) => c.id !== id))}
        text={text}
        onTextChange={setText}
        suggestions={text ? SUGGESTIONS : []}
        onApplySuggestion={(s) => {
          onApply(s);
          setChips((cur) => [...cur, { id: s.id, label: String(s.label) }]);
          setText("");
        }}
        footerAction={advanced ? { label: "Advanced filter", onSelect: advanced } : undefined}
      />
    );
  }
  const CHIPS: FilterBarChip[] = [
    { id: "c1", label: "Status is Todo" },
    { id: "c2", label: "Owner is me" },
  ];

  it("holds its chips before the text and has the 2 px focus ring around it when focused (A11Y-2)", async () => {
    render(<Harness initialChips={CHIPS} />);
    const input = screen.getByRole("combobox", { name: "Filter or search" });
    expect(screen.getByText("Status is Todo")).toBeInTheDocument();
    const field = input.parentElement!;
    expect(field).toHaveClass("focus-within:border-primary", "focus-within:outline-2", "focus-within:outline-offset-2", "focus-within:outline-ring");
    // Chips come before the input in the one field.
    expect(field.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(screen.getByText("Owner is me").compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("selects the last chip on Backspace in the empty field and removes it on the second", async () => {
    const user = userEvent.setup();
    render(<Harness initialChips={CHIPS} />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{Backspace}");
    const last = screen.getByText("Owner is me").closest("[data-selected]");
    expect(last).toBeInTheDocument();
    expect(screen.getByText("Status is Todo").closest("[data-selected]")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Press Backspace again to remove Owner is me");
    await user.keyboard("{Backspace}");
    expect(screen.queryByText("Owner is me")).not.toBeInTheDocument();
    expect(screen.getByText("Status is Todo")).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("lets go of the selected chip when typing, so Backspace edits the text", async () => {
    const user = userEvent.setup();
    render(<Harness initialChips={CHIPS} />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{Backspace}");
    await user.keyboard("ab");
    expect(document.querySelector("[data-selected]")).toBeNull();
    await user.keyboard("{Backspace}{Backspace}");
    expect(screen.getByText("Owner is me")).toBeInTheDocument();
  });

  it("does not remove a chip on Backspace while there is text", async () => {
    const user = userEvent.setup();
    render(<Harness initialChips={CHIPS} />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("x{Backspace}{Backspace}");
    expect(document.querySelector("[data-selected]")).toBeInTheDocument();
    expect(screen.getByText("Owner is me")).toBeInTheDocument();
  });

  it("opens suggestions while typing, highlights the first and applies the highlighted one on Enter", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.type(input, "done");
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    expect(screen.getByRole("status")).toHaveTextContent("3 suggestions");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
    expect(screen.getByText("Notes contain “done”")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("applies a suggestion that is clicked, without losing focus from the field", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "done");
    await user.click(await screen.findByRole("option", { name: /Search every property/ }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "s3" }));
    expect(input).toHaveFocus();
  });

  it("closes the suggestions on the first Escape and empties the field on the second", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await user.type(input, "done");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveValue("done");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
  });

  it("ends with an Advanced filter row that the keys reach", async () => {
    const user = userEvent.setup();
    const advanced = vi.fn();
    render(<Harness advanced={advanced} />);
    await user.type(screen.getByRole("combobox"), "done");
    await screen.findAllByRole("option");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(advanced).toHaveBeenCalledTimes(1);
  });

  it("removes a chip with its button and keeps focus in the field", async () => {
    const user = userEvent.setup();
    render(<Harness initialChips={CHIPS} />);
    await user.click(screen.getByRole("button", { name: "Remove Status is Todo" }));
    expect(screen.queryByText("Status is Todo")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });
});

describe("FilterBar: where its panels go", () => {
  const SUGGESTIONS: FilterBarSuggestion[] = [{ id: "s1", label: "Status is Done" }];
  function Harness({ onClose }: { onClose?: () => void }) {
    const [text, setText] = useState("");
    const chips: FilterBarChip[] = [
      {
        id: "c1",
        label: "Status is Todo",
        editor: (close) => (
          <div>
            <label>
              Value <input defaultValue="Todo" />
            </label>
            <button
              onClick={() => {
                onClose?.();
                close();
              }}
            >
              Finish
            </button>
          </div>
        ),
      },
    ];
    return <FilterBar chips={chips} onRemoveChip={() => {}} text={text} onTextChange={setText} suggestions={text ? SUGGESTIONS : []} onApplySuggestion={() => {}} />;
  }

  it("on a desktop, draws the suggestions in a popover under the field", async () => {
    stubDesktop();
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole("combobox"), "done");
    const list = await screen.findByRole("listbox", { name: "Suggestions" });
    expect(list.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
  });

  it("on a phone, draws them in a panel docked to the bottom of the screen that is not a popover", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole("combobox"), "done");
    const list = await screen.findByRole("listbox", { name: "Suggestions" });
    expect(list.closest("[data-radix-popper-content-wrapper]")).toBeNull();
    expect(list.parentElement).toHaveClass("fixed", "inset-x-0");
    // Focus stays in the field for the keys.
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("opens a chip's editor in a popover on a desktop, and closing it gives focus back to the chip", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Status is Todo" }));
    const input = await screen.findByRole("textbox", { name: "Value" });
    expect(input.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
    // A click inside the editor is not a click on the field: focus stays where the person put it.
    await user.click(input);
    expect(input).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Value" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Status is Todo" })).toHaveFocus());
  });

  it("opens it as a sheet on a phone, named for the chip", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Status is Todo" }));
    const sheet = await screen.findByRole("dialog", { name: "Status is Todo" });
    expect(within(sheet).getByRole("textbox", { name: "Value" })).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("TemporaryChangesBar", () => {
  it("says what is shown and that it is only for now, with Reset and Save as view", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const onSave = vi.fn();
    render(<TemporaryChangesBar shown={3} total={12} onReset={onReset} onSaveAsView={onSave} />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing 3 of 12. This filter is only for now.");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Save as view" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Reset" })).toHaveClass("hover:bg-hover");
    expect(screen.getByRole("button", { name: "Save as view" })).toHaveClass("bg-primary-soft", "text-primary-ink");
  });

  it("offers no Save as view to someone who may not make views", () => {
    render(<TemporaryChangesBar shown={1} total={2} onReset={() => {}} />);
    expect(screen.queryByRole("button", { name: "Save as view" })).not.toBeInTheDocument();
  });

  it("keeps one polite live region in the page whether or not it is open, and announces the change of count", () => {
    const { rerender } = render(<TemporaryChangesBar open={false} shown={12} total={12} onReset={() => {}} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    rerender(<TemporaryChangesBar shown={3} total={12} onReset={() => {}} />);
    // The same element, now with text: that is what a screen reader announces.
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Showing 3 of 12.");
    rerender(<TemporaryChangesBar shown={5} total={12} onReset={() => {}} />);
    expect(region).toHaveTextContent("Showing 5 of 12.");
  });

  it("can describe a draft that changes no count", () => {
    render(<TemporaryChangesBar summary="Sorted by Due date." note="This sort is only for now." onReset={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sorted by Due date. This sort is only for now.");
  });

  it("names the records after the count, and says when the view changed under the draft", () => {
    render(<TemporaryChangesBar shown={3} total={12} noun="clients" note="These changes are only for now." alert="This view changed since you started." onReset={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing 3 of 12 clients. These changes are only for now. This view changed since you started.");
  });

  it("puts Update view between Reset and Save as view, and shows it working", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const { rerender } = render(<TemporaryChangesBar onReset={() => {}} onUpdateView={onUpdate} onSaveAsView={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Reset", "Update view", "Save as view"]);
    await user.click(screen.getByRole("button", { name: "Update view" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    rerender(<TemporaryChangesBar onReset={() => {}} onUpdateView={onUpdate} updating />);
    expect(screen.getByRole("button", { name: /Update view/ })).toBeDisabled();
  });
});

describe("Toast", () => {
  function Trigger({ options }: { options: ToastOptions }) {
    const { toast } = useToast();
    return <button onClick={() => toast(options)}>go</button>;
  }
  function setup(options: ToastOptions) {
    return render(
      <ToastProvider>
        <Trigger options={options} />
      </ToastProvider>,
    );
  }

  it("lives in a polite live region that is in the page before any toast, bottom-left on a desktop and above the tab bar on a phone", () => {
    setup({ title: "Saved" });
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region.querySelector("[aria-live=polite]")).toBeInTheDocument();
    expect(region).toHaveClass("bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom))]", "md:right-auto");
  });

  it("announces a toast inside that region", async () => {
    setup({ title: "Added to Tasks" });
    await userEvent.click(screen.getByText("go"));
    expect(within(screen.getByRole("region", { name: "Notifications" }).querySelector("[aria-live=polite]") as HTMLElement).getByRole("status")).toHaveTextContent("Added to Tasks");
  });

  it("runs an Undo and closes", async () => {
    const onUndo = vi.fn();
    setup({ title: "Deleted 2 records", action: { label: "Undo", onClick: onUndo } });
    await userEvent.click(screen.getByText("go"));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Deleted 2 records")).not.toBeInTheDocument();
  });

  it("can carry several actions, each closing the toast", async () => {
    const open = vi.fn();
    const undo = vi.fn();
    setup({
      title: "Added to Tasks",
      actions: [
        { label: "Open", onClick: open },
        { label: "Undo", onClick: undo },
      ],
    });
    await userEvent.click(screen.getByText("go"));
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["go", "Open", "Undo", "Dismiss"]);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(screen.queryByText("Added to Tasks")).not.toBeInTheDocument();
  });

  it("runs an action once even when it is pressed again while the toast is leaving", async () => {
    // jsdom has no animations, so a toast would leave at once; say there is one so it stays mounted.
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      return new Proxy(style, {
        get: (t, k) => {
          if (k === "animationName") return "ob-rise-out";
          const v = Reflect.get(t, k, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    });
    try {
      const onUndo = vi.fn();
      setup({ title: "Removed heading", action: { label: "Undo", onClick: onUndo } });
      await userEvent.click(screen.getByText("go"));
      const undo = screen.getByRole("button", { name: "Undo" });
      fireEvent.click(undo);
      expect(screen.getByText("Removed heading")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveAttribute("data-state", "closed");
      fireEvent.click(undo);
      expect(onUndo).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("waits while the pointer or keyboard is on it, then goes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setup({ title: "Deleted", durationMs: 1000, action: { label: "Undo", onClick: () => {} } });
      await user.click(screen.getByText("go"));
      await user.hover(screen.getByText("Deleted"));
      act(() => void vi.advanceTimersByTime(3000));
      expect(screen.getByText("Deleted")).toBeInTheDocument();
      await user.unhover(screen.getByText("Deleted"));
      act(() => void vi.advanceTimersByTime(1100));
      expect(screen.queryByText("Deleted")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a toast with an action longer than a plain note", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setup({ title: "Deleted", action: { label: "Undo", onClick: () => {} } });
      await user.click(screen.getByText("go"));
      act(() => void vi.advanceTimersByTime(6000));
      expect(screen.getByText("Deleted")).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(3000));
      expect(screen.queryByText("Deleted")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("motion", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/index.css"), "utf8");

  it("leaves 30% faster than it enters, on the same curve", () => {
    expect(css).toMatch(/--duration-slow-leave:\s*calc\(var\(--duration-slow\) \* 0\.7\)/);
    expect(css).toMatch(/\.ob-sheet-in\[data-state="closed"\]\s*\{\s*animation: ob-sheet-out var\(--duration-slow-leave\) var\(--ease-enter\)/);
    expect(css).toMatch(/\.ob-pop-in\[data-state="closed"\]\s*\{\s*animation: ob-pop-out var\(--duration-base-leave\)/);
    expect(css).toMatch(/\.ob-dialog-in\s*\{\s*animation: ob-pop-in var\(--duration-slow\)/);
  });

  it("fades for 120 ms instead of sliding or scaling under reduced motion, in and out", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const cls of [".ob-sheet-in", ".ob-pop-in", ".ob-dialog-in", ".ob-rise-in", ".ob-slide-in"]) {
      expect(reduced).toMatch(new RegExp(`\\${cls}\\s*[,{]`));
      expect(reduced).toContain(`${cls}[data-state="closed"]`);
    }
    expect(reduced).toMatch(/animation: ob-fade-in var\(--duration-fast\)/);
    expect(reduced).toMatch(/animation: ob-fade-out var\(--duration-fast\)/);
  });
});
