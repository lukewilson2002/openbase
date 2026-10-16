import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableRecord } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { buildStacks, stackValue, type DropPlan } from "./stacks";
import { KanbanBoard, type KanbanBoardProps } from "./KanbanBoard";
import { installBoardLayout, type BoardLayout } from "./boardLayout";

const status = ALL_FIELDS.single_select!;
const name = ALL_FIELDS.single_line_text!;

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
});
