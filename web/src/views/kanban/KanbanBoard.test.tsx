import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableRecord } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { buildStacks, clearStack, stackValue, type DropPlan } from "./stacks";
import { KanbanBoard, type KanbanBoardProps } from "./KanbanBoard";
import { installBoardLayout, type BoardLayout } from "./boardLayout";

const status = ALL_FIELDS.single_select!;
const name = ALL_FIELDS.text!;

const records: TableRecord[] = [
  makeRecord({ [name.id]: "Write docs", [status.id]: "chs1" }, "r1"),
  makeRecord({ [name.id]: "Fix bug", [status.id]: "chs1" }, "r2"),
  makeRecord({ [name.id]: "Ship it", [status.id]: "chs2" }, "r3"),
];

function board(over: Partial<KanbanBoardProps> = {}) {
  const stacks = buildStacks(status, records, { stackOrder: ["chs1", "chs2", "chs3"], hideEmpty: false, people: [] }).filter((s) => !s.uncategorized);
  const props: KanbanBoardProps = {
    stacks,
    primary: name,
    fields: [],
    format: DEFAULT_CTX,
    emails: new Map(),
    colors: { r1: "red" },
    canEdit: true,
    canConfigure: true,
    hasSorts: false,
    collapsed: new Set(),
    onToggleCollapse: vi.fn(),
    onMoveStack: vi.fn(),
    onDrop: vi.fn(),
    onAddCard: vi.fn(),
    onOpen: vi.fn(),
    onDeleteRecords: vi.fn(),
    onDuplicateRecords: vi.fn(),
    onMoveRecords: vi.fn(),
    ...over,
  };
  return { props, ...render(<KanbanBoard {...props} />) };
}

// jsdom has no layout, and dnd-kit's keyboard coordinates come from element rects (see boardLayout.ts).
let layout: BoardLayout;
beforeEach(() => {
  layout = installBoardLayout();
});
afterEach(() => layout.restore());

async function keyboardDrag(user: ReturnType<typeof userEvent.setup>, card: HTMLElement, keys: string[]) {
  card.focus();
  await user.keyboard(" ");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  for (const k of keys) {
    await user.keyboard(k);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  await user.keyboard(" ");
}

describe("KanbanBoard", () => {
  it("renders stacks in order with counts, cards, row colours and an add button per stack", () => {
    board();
    const stacksEl = screen.getAllByRole("listitem");
    expect(stacksEl.map((s) => s.getAttribute("aria-label"))).toEqual(["Stack: Todo", "Stack: In progress", "Stack: Done"]);
    const todo = within(screen.getByRole("listitem", { name: "Stack: Todo" }));
    expect(todo.getAllByRole("button", { name: /Write docs|Fix bug/ })).toHaveLength(2);
    expect(todo.getByText("2 items")).toBeInTheDocument();
    expect(document.querySelector("[data-record-id='r1'] [data-row-color='red']")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /^Add card to/ })).toHaveLength(3);
    expect(within(screen.getByRole("listitem", { name: "Stack: Done" })).getByText("No cards")).toBeInTheDocument();
  });

  it("collapses a stack from its menu, keeping its count", async () => {
    const user = userEvent.setup();
    const { props } = board();
    await user.click(screen.getByRole("button", { name: "Options for Todo" }));
    await user.click(await screen.findByRole("menuitem", { name: "Collapse stack" }));
    expect(props.onToggleCollapse).toHaveBeenCalledWith(expect.any(String));
  });

  it("opens the record on click and on Enter", async () => {
    const user = userEvent.setup();
    const { props } = board();
    await user.click(screen.getByRole("button", { name: "Ship it" }));
    expect(props.onOpen).toHaveBeenCalledWith("r3");
    screen.getByRole("button", { name: "Fix bug" }).focus();
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith("r2");
  });

  it("moves a card to the next stack with the keyboard and reports the write", async () => {
    const user = userEvent.setup();
    const { props } = board();
    await keyboardDrag(user, screen.getByRole("button", { name: "Write docs" }), ["{ArrowRight}"]);
    await waitFor(() => expect(props.onDrop).toHaveBeenCalledTimes(1));
    const plan = vi.mocked(props.onDrop).mock.calls[0]![0] as DropPlan;
    expect(plan.recordId).toBe("r1");
    expect(plan.fromKey).toBe("chs1");
    expect(plan.toKey).toBe("chs2");
    expect(plan.changeValue).toBe(true);
    expect(stackValue(status, plan.toKey)).toBe("chs2");
    // The card shows in its new stack straight away.
    expect(within(screen.getByRole("listitem", { name: "Stack: In progress" })).getByRole("button", { name: "Write docs" })).toBeInTheDocument();
  });

  it("moves a card to the previous stack with a single Left press (the own stack is not a stop)", async () => {
    const user = userEvent.setup();
    const { props } = board();
    // "Ship it" is the first card of the second stack.
    layout.overlayAt(1);
    await keyboardDrag(user, screen.getByRole("button", { name: "Ship it" }), ["{ArrowLeft}"]);
    await waitFor(() => expect(props.onDrop).toHaveBeenCalledTimes(1));
    expect(vi.mocked(props.onDrop).mock.calls[0]![0]).toMatchObject({ recordId: "r3", fromKey: "chs2", toKey: "chs1", changeValue: true });
  });

  it("reorders inside a stack with the keyboard only when the view has no sorts", async () => {
    const user = userEvent.setup();
    const first = board();
    await keyboardDrag(user, screen.getByRole("button", { name: "Write docs" }), ["{ArrowDown}"]);
    await waitFor(() => expect(first.props.onDrop).toHaveBeenCalledTimes(1));
    const plan = vi.mocked(first.props.onDrop).mock.calls[0]![0] as DropPlan;
    expect(plan).toMatchObject({ recordId: "r1", fromKey: "chs1", toKey: "chs1", changeValue: false, anchor: { afterId: "r2" } });
    first.unmount();

    const user2 = userEvent.setup();
    const sorted = board({ hasSorts: true });
    await keyboardDrag(user2, screen.getAllByRole("button", { name: "Write docs" })[0]!, ["{ArrowDown}"]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(sorted.props.onDrop).not.toHaveBeenCalled();
  });

  it("cannot drag when the role may not edit, but still opens cards and hides add buttons", async () => {
    const user = userEvent.setup();
    const { props } = board({ canEdit: false });
    expect(screen.queryByRole("button", { name: /^Add card to/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write docs" })).toHaveAttribute("aria-roledescription", "card");
    await keyboardDrag(user, screen.getByRole("button", { name: "Write docs" }), ["{ArrowRight}"]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(props.onDrop).not.toHaveBeenCalled();
  });

  it("collapses a stack, adds a card to a stack and moves stacks", async () => {
    const user = userEvent.setup();
    const { props } = board({ collapsed: new Set(["chs2"]) });
    const inProgress = within(screen.getByRole("listitem", { name: "Stack: In progress" }));
    expect(inProgress.queryByRole("button", { name: "Ship it" })).not.toBeInTheDocument();
    await user.click(inProgress.getByRole("button", { name: "Expand In progress" }));
    expect(props.onToggleCollapse).toHaveBeenCalledWith("chs2");
    await user.click(screen.getByRole("button", { name: "Add card to Todo" }));
    expect(props.onAddCard).toHaveBeenCalledWith("chs1");
    await user.click(screen.getByRole("button", { name: "Options for Todo" }));
    expect(await screen.findByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(props.onMoveStack).toHaveBeenCalledWith("chs1", 1);
  });
  describe("screen readers", () => {
    it("announces card titles and stack names, never ids, and explains the keys", async () => {
      const user = userEvent.setup();
      board();
      const card = screen.getByRole("button", { name: "Write docs" });
      const instructions = document.getElementById(card.getAttribute("aria-describedby")!);
      expect(instructions).toHaveTextContent(/press Space/);
      expect(instructions).toHaveTextContent(/Escape to cancel/);
      // Everything the live region said, in order.
      const heard: string[] = [];
      const observer = new MutationObserver(() => {
        const text = document.querySelector("[aria-live]")?.textContent;
        if (text && heard[heard.length - 1] !== text) heard.push(text);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      card.focus();
      await user.keyboard(" ");
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      await user.keyboard("{ArrowRight}");
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      await user.keyboard(" ");
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      observer.disconnect();
      expect(heard).toContain("Picked up Write docs, in the Todo stack, position 1 of 2.");
      expect(heard.some((h) => /^Write docs is over the In progress stack/.test(h))).toBe(true);
      expect(heard.some((h) => /^Dropped Write docs in the In progress stack, position \d of 2\./.test(h))).toBe(true);
      expect(heard.join(" ")).not.toMatch(/r1|chs\d/);
    });
  });

  describe("clearing a value", () => {
    it("offers an empty Uncategorized stack only while a card is dragged, and a drop there clears the stack", async () => {
      const user = userEvent.setup();
      const { props } = board({ clearStack: clearStack(status, [{ key: "chs1" }]), fieldName: "Status" });
      expect(screen.queryByRole("listitem", { name: "Stack: Uncategorized" })).not.toBeInTheDocument();
      screen.getByRole("button", { name: "Write docs" }).focus();
      await user.keyboard(" ");
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      expect(screen.getByRole("listitem", { name: "Stack: Uncategorized" })).toHaveTextContent("Drop a card here to clear its Status.");
      for (const k of ["{ArrowRight}", "{ArrowRight}", "{ArrowRight}"]) {
        await user.keyboard(k);
        await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      }
      await user.keyboard(" ");
      await waitFor(() => expect(props.onDrop).toHaveBeenCalledTimes(1));
      expect(vi.mocked(props.onDrop).mock.calls[0]![0]).toMatchObject({ recordId: "r1", fromKey: "chs1", toKey: "", changeValue: true });
      expect(stackValue(status, "")).toBeNull();
    });
  });

  describe("stack menu", () => {
    it("renames, recolours, hides and deletes a stack that is a choice, telling what deleting does", async () => {
      const user = userEvent.setup();
      const onRenameStack = vi.fn().mockResolvedValue(undefined);
      const onColorStack = vi.fn().mockResolvedValue(undefined);
      const onDeleteStack = vi.fn().mockResolvedValue(undefined);
      const onHideStack = vi.fn();
      board({ onRenameStack, onColorStack, onDeleteStack, onHideStack, fieldName: "Status" });

      await user.click(screen.getByRole("button", { name: "Options for Todo" }));
      await user.click(await screen.findByRole("menuitem", { name: "Hide stack" }));
      expect(onHideStack).toHaveBeenCalledWith("chs1");

      await user.click(screen.getByRole("button", { name: "Options for Todo" }));
      await user.click(await screen.findByRole("menuitem", { name: "Rename stack" }));
      const input = await screen.findByRole("textbox", { name: "Stack name" });
      await user.clear(input);
      await user.type(input, "Backlog");
      await user.click(screen.getByRole("button", { name: "Rename" }));
      await waitFor(() => expect(onRenameStack).toHaveBeenCalledWith("chs1", "Backlog"));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Options for Todo" }));
      await user.click(await screen.findByRole("menuitem", { name: "Change colour" }));
      await user.click(await screen.findByRole("radio", { name: "Blue" }));
      await waitFor(() => expect(onColorStack).toHaveBeenCalledWith("chs1", expect.stringMatching(/blue/)));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Options for Todo" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete stack" }));
      const confirm = await screen.findByRole("alertdialog");
      expect(confirm).toHaveTextContent('Delete the stack "Todo"?');
      expect(confirm).toHaveTextContent(/2 cards in this stack will keep their other values but have no Status value/);
      expect(onDeleteStack).not.toHaveBeenCalled();
      await user.click(within(confirm).getByRole("button", { name: "Delete stack" }));
      await waitFor(() => expect(onDeleteStack).toHaveBeenCalledWith("chs1"));
    });

    it("offers none of that without the handlers, and keeps Hide for people who may change the view", async () => {
      const user = userEvent.setup();
      board({ canConfigure: false, onHideStack: vi.fn() });
      await user.click(screen.getByRole("button", { name: "Options for Todo" }));
      expect(await screen.findByRole("menuitem", { name: "Collapse stack" })).toBeInTheDocument();
      for (const name of ["Rename stack", "Change colour", "Delete stack", "Hide stack", "Move left"]) expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
    });

    it("brings hidden stacks back from the end of the board", async () => {
      const user = userEvent.setup();
      const onShowStack = vi.fn();
      const hidden = buildStacks(status, records, { stackOrder: [], hideEmpty: false, people: [] }).filter((s) => s.key === "chs3");
      board({ hiddenStacks: hidden, onShowStack });
      await user.click(screen.getByRole("button", { name: "1 hidden stack" }));
      await user.click(await screen.findByRole("menuitem", { name: /Show Done/ }));
      expect(onShowStack).toHaveBeenCalledWith("chs3");
    });

    it("says why no stack can be added where the button is missing", () => {
      board({ addStackNote: "A checkbox always has two stacks: checked and unchecked." });
      expect(screen.getByText(/always has two stacks/)).toBeInTheDocument();
    });
  });

  describe("reordering stacks by dragging the header", () => {
    it("saves the new order once, from the keys of the shown stacks", async () => {
      const onReorderStacks = vi.fn();
      board({ onReorderStacks });
      const header = screen.getByRole("heading", { name: "Todo" }).parentElement!;
      fireEvent.mouseDown(header, { button: 0, clientX: 100, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 130, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 400, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 410, clientY: 10 });
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      fireEvent.mouseUp(document);
      await waitFor(() => expect(onReorderStacks).toHaveBeenCalledTimes(1));
      expect(onReorderStacks).toHaveBeenCalledWith(["chs2", "chs1", "chs3"]);
      // They stay where they were dropped until the saved order comes back.
      expect(screen.getAllByRole("listitem").map((s) => s.getAttribute("aria-label"))).toEqual(["Stack: In progress", "Stack: Todo", "Stack: Done"]);
      await act(async () => void (await new Promise((r) => setTimeout(r, 60)))); // dnd-kit swallows the click after a drag for a moment
    });

    it("does not drag headers without the permission to change the view", () => {
      const onReorderStacks = vi.fn();
      board({ onReorderStacks, canConfigure: false });
      const header = screen.getByRole("heading", { name: "Todo" }).parentElement!;
      fireEvent.mouseDown(header, { button: 0, clientX: 100, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 410, clientY: 10 });
      fireEvent.mouseUp(document);
      expect(onReorderStacks).not.toHaveBeenCalled();
    });
  });

  describe("selecting cards", () => {
    it("selects with Ctrl-click and Shift-click, shows the bar, and deletes, duplicates and moves the selection", async () => {
      const user = userEvent.setup();
      const { props } = board();
      await user.keyboard("{Control>}");
      await user.click(screen.getByRole("button", { name: "Write docs" }));
      await user.keyboard("{/Control}");
      expect(props.onOpen).not.toHaveBeenCalled();
      expect(screen.getByRole("toolbar", { name: "Selected records" })).toHaveTextContent("1 selected");
      expect(screen.getByRole("button", { name: "Write docs" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Ship it" })).toHaveAttribute("aria-pressed", "false");
      // A plain click now selects too; a Shift-click takes the range from the last click.
      await user.keyboard("{Shift>}");
      await user.click(screen.getByRole("button", { name: "Ship it" }));
      await user.keyboard("{/Shift}");
      expect(screen.getByRole("toolbar")).toHaveTextContent("3 selected");

      const bar = within(screen.getByRole("toolbar", { name: "Selected records" }));
      await user.click(bar.getByRole("button", { name: "Duplicate" }));
      expect(props.onDuplicateRecords).toHaveBeenCalledWith(["r1", "r2", "r3"], expect.any(Function));
      await user.click(bar.getByRole("button", { name: "Delete" }));
      expect(props.onDeleteRecords).toHaveBeenCalledWith(["r1", "r2", "r3"], expect.any(Function));
      await user.click(bar.getByRole("button", { name: "Move to" }));
      await user.click(await screen.findByRole("menuitem", { name: "Done" }));
      expect(props.onMoveRecords).toHaveBeenCalledWith(["r1", "r2", "r3"], "chs3", expect.any(Function));
    });

    it("Delete removes the selection, or the focused card when nothing is selected; Escape lets go; X selects", async () => {
      const user = userEvent.setup();
      const { props } = board();
      screen.getByRole("button", { name: "Fix bug" }).focus();
      await user.keyboard("{Delete}");
      expect(props.onDeleteRecords).toHaveBeenLastCalledWith(["r2"]);

      screen.getByRole("button", { name: "Fix bug" }).focus();
      await user.keyboard("x");
      expect(screen.getByRole("toolbar")).toHaveTextContent("1 selected");
      await user.keyboard("{Delete}");
      expect(props.onDeleteRecords).toHaveBeenLastCalledWith(["r2"], expect.any(Function));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      await user.keyboard("{Control>}a{/Control}");
      expect(screen.getByRole("toolbar")).toHaveTextContent("3 selected");
    });

    it("Delete moves focus to a neighbouring card instead of dropping it", async () => {
      const user = userEvent.setup();
      board();
      screen.getByRole("button", { name: "Write docs" }).focus();
      await user.keyboard("{Delete}");
      expect(screen.getByRole("button", { name: "Fix bug" })).toHaveFocus();
    });

    it("Escape while carrying a card cancels the drag and keeps the selection", async () => {
      const user = userEvent.setup();
      const { props } = board();
      screen.getByRole("button", { name: "Write docs" }).focus();
      await user.keyboard("x");
      expect(screen.getByRole("toolbar")).toHaveTextContent("1 selected");
      await user.keyboard(" ");
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      await user.keyboard("{Escape}");
      expect(screen.getByRole("toolbar")).toHaveTextContent("1 selected");
      expect(props.onDrop).not.toHaveBeenCalled();
    });

    it("cannot select or delete without edit rights", async () => {
      const user = userEvent.setup();
      const { props } = board({ canEdit: false });
      await user.keyboard("{Control>}");
      await user.click(screen.getByRole("button", { name: "Write docs" }));
      await user.keyboard("{/Control}");
      expect(props.onOpen).toHaveBeenCalledWith("r1");
      screen.getByRole("button", { name: "Write docs" }).focus();
      await user.keyboard("{Delete}x");
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      expect(props.onDeleteRecords).not.toHaveBeenCalled();
    });

    it("has a card menu with Duplicate and Delete that act on the selection when the card is in it", async () => {
      const user = userEvent.setup();
      const { props } = board();
      fireEvent.contextMenu(screen.getByRole("button", { name: "Write docs" }), { clientX: 20, clientY: 20 });
      await user.click(await screen.findByRole("menuitem", { name: "Delete record" }));
      expect(props.onDeleteRecords).toHaveBeenLastCalledWith(["r1"], expect.any(Function));

      await user.keyboard("{Control>}");
      await user.click(screen.getByRole("button", { name: "Write docs" }));
      await user.click(screen.getByRole("button", { name: "Fix bug" }));
      await user.keyboard("{/Control}");
      fireEvent.contextMenu(screen.getByRole("button", { name: "Fix bug" }), { clientX: 20, clientY: 20 });
      await user.click(await screen.findByRole("menuitem", { name: "Duplicate 2 records" }));
      expect(props.onDuplicateRecords).toHaveBeenLastCalledWith(["r1", "r2"], expect.any(Function));

      fireEvent.contextMenu(screen.getByRole("button", { name: "Ship it" }), { clientX: 20, clientY: 20 });
      fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Move to stack" }), { key: "ArrowRight" });
      await user.click(await screen.findByRole("menuitem", { name: "Done" }));
      expect(props.onMoveRecords).toHaveBeenLastCalledWith(["r3"], "chs3", expect.any(Function));
    });
  });

  describe("keyboard navigation", () => {
    it("makes one card the tab stop and moves between cards and stacks with the arrow keys", async () => {
      const user = userEvent.setup();
      board();
      const card = (n: string) => screen.getByRole("button", { name: n });
      expect(card("Write docs")).toHaveAttribute("tabindex", "0");
      expect(card("Fix bug")).toHaveAttribute("tabindex", "-1");
      card("Write docs").focus();
      await user.keyboard("{ArrowDown}");
      expect(card("Fix bug")).toHaveFocus();
      expect(card("Fix bug")).toHaveAttribute("tabindex", "0");
      expect(card("Write docs")).toHaveAttribute("tabindex", "-1");
      await user.keyboard("{ArrowRight}");
      expect(card("Ship it")).toHaveFocus();
      await user.keyboard("{ArrowLeft}{Home}");
      expect(card("Write docs")).toHaveFocus();
      await user.keyboard("{End}");
      expect(card("Fix bug")).toHaveFocus();
      await user.keyboard("{ArrowUp}{ArrowUp}");
      expect(card("Write docs")).toHaveFocus();
    });
  });

  describe("tab stop", () => {
    it("moves to a drawn card when the focused one goes out of sight with its stack", async () => {
      const { props, rerender } = board();
      act(() => screen.getByRole("button", { name: "Write docs" }).focus());
      // Collapsing the stack the card sits in leaves no card of it to tab to; the next stack's first is the stop.
      rerender(<KanbanBoard {...props} collapsed={new Set(["chs1"])} />);
      expect(screen.queryByRole("button", { name: "Write docs" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ship it" })).toHaveAttribute("tabindex", "0");
    });

    it("does not call a card disabled when its person cannot edit (it still opens)", () => {
      board({ canEdit: false });
      expect(screen.getByRole("button", { name: "Write docs" })).not.toHaveAttribute("aria-disabled");
    });
  });

  describe("links inside a card", () => {
    it("follow on Enter instead of opening the record, which Enter on the card itself still does", async () => {
      const user = userEvent.setup();
      const url = ALL_FIELDS.url!;
      const withLink = [makeRecord({ [name.id]: "Docs page", [status.id]: "chs1", [url.id]: "https://example.com/docs" }, "r9")];
      const stacks = buildStacks(status, withLink, { stackOrder: ["chs1"], hideEmpty: true, people: [] });
      const { props } = board({ stacks, fields: [url] });
      const link = screen.getByRole("link", { name: /example\.com/ });
      link.addEventListener("click", (e) => e.preventDefault());
      let followed = 0;
      link.addEventListener("click", () => followed++);
      link.focus();
      await user.keyboard("{Enter}");
      expect(props.onOpen).not.toHaveBeenCalled();
      expect(followed).toBe(1);
      screen.getByRole("button", { name: "Docs page" }).focus();
      await user.keyboard("{Enter}");
      expect(props.onOpen).toHaveBeenCalledWith("r9");
    });
  });
});
