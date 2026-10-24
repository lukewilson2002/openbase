import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GroupHeader, TableRecord } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import type { RecordSelection } from "../common/useRecordSelection";
import { ListOutline, ROWS_PER_GROUP, type ListOutlineProps } from "./ListOutline";

const name = ALL_FIELDS.text!;
const status = ALL_FIELDS.single_select!;
const num = ALL_FIELDS.number!;

const rec = (id: string, title: string, v: Record<string, unknown> = {}): TableRecord => makeRecord({ [name.id]: title, ...v }, id);
const records = [rec("r1", "Write docs", { [status.id]: "chs1", [num.id]: 3 }), rec("r2", "Fix bug", { [status.id]: "chs1" }), rec("r3", "Ship it", { [status.id]: "chs3" }), rec("r4", "Idea", {})];
const header = (depth: number, key: string, label: string, start: number, count: number, value: unknown = key): GroupHeader => ({ depth, field_id: status.id, key, label, value: value as GroupHeader["value"], start, count });
const groups = [header(0, "chs1", "Todo", 0, 2), header(0, "chs3", "Done", 2, 1), header(0, "", "(Empty)", 3, 1, null)];

function outline(over: Partial<ListOutlineProps> = {}) {
  const props: ListOutlineProps = {
    records,
    groups,
    primary: name,
    fields: [num],
    tableFields: [name, status, num],
    format: DEFAULT_CTX,
    emails: new Map(),
    colors: { r1: "red" },
    collapsed: new Set(),
    canEdit: true,
    onToggle: vi.fn(),
    onOpen: vi.fn(),
    onAdd: vi.fn(),
    ...over,
  };
  return { props, ...render(<ListOutline {...props} />) };
}

const fakeSelection = (over: Partial<RecordSelection> = {}): RecordSelection => ({
  ids: [],
  count: 0,
  has: () => false,
  toggle: vi.fn(),
  set: vi.fn(),
  selectAll: vi.fn(),
  clear: vi.fn(),
  handleClick: vi.fn(() => false),
  handleKeyDown: vi.fn(() => false),
  ...over,
});

describe("ListOutline", () => {
  it("shows group headers with counts and each group's records, with their fields", () => {
    outline();
    const tree = screen.getByRole("tree", { name: "Grouped records" });
    const headers = within(tree).getAllByRole("treeitem");
    expect(headers.map((h) => h.textContent)).toEqual(["Todo2", "Done1", "(Empty)1"]);
    expect(within(tree).getByRole("button", { name: "Collapse Todo" })).toBeInTheDocument();
    expect(headers[0]).toHaveAttribute("aria-expanded", "true");
    // Records sit under their group in order, with the number field shown when set.
    const row = screen.getByRole("button", { name: "Write docs" });
    expect(within(row).getByText("number")).toBeInTheDocument();
    expect(within(row).getByText("3.00")).toBeInTheDocument();
    expect(row.querySelector("[data-row-color='red']")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /^(Write docs|Fix bug|Ship it|Idea)$/ })).toHaveLength(4);
  });

  it("shows every field the view shows that has a value, not just the first few, and leaves empty ones out", () => {
    const extra = [ALL_FIELDS.email!, ALL_FIELDS.url!, ALL_FIELDS.percent!, ALL_FIELDS.currency!];
    const full = rec("r9", "Everything", { [num.id]: 3, [extra[0]!.id]: "a@b.co", [extra[1]!.id]: "https://example.com", [extra[2]!.id]: 0.5, [extra[3]!.id]: null });
    outline({ records: [full], groups: [], fields: [num, ...extra] });
    const row = screen.getByRole("button", { name: "Everything" });
    for (const f of [num, extra[0]!, extra[1]!, extra[2]!]) expect(within(row).getByText(f.name)).toBeInTheDocument();
    expect(within(row).queryByText(extra[3]!.name)).not.toBeInTheDocument();
  });

  it("fills a choice group's heading with its colour (no dot) and shows select values as bare pills", () => {
    outline({ fields: [status, num] });
    const heading = within(screen.getAllByRole("treeitem")[0]!).getByRole("button");
    expect(heading).toHaveClass("ob-fill");
    expect(heading.querySelector(".ob-dot")).toBeNull();
    const row = screen.getByRole("button", { name: "Write docs" });
    expect(within(row).queryByText(status.name)).not.toBeInTheDocument();
    expect(within(row).getByText("number")).toBeInTheDocument();
  });

  it("puts the person's face on a person group", () => {
    const owner = ALL_FIELDS.user!;
    outline({ groups: [{ ...header(0, "usr1", "Ada Lovelace", 0, 4, ["usr1"]), field_id: owner.id }], tableFields: [name, owner] });
    expect(screen.getByRole("treeitem").querySelector("[role=img]")).toHaveTextContent("AL");
  });

  it("nests up to three levels with their own counts", () => {
    const nested: GroupHeader[] = [
      header(0, "chs1", "Todo", 0, 2),
      { ...header(1, "a", "Ada", 0, 1), field_id: "owner" },
      { ...header(2, "x", "Urgent", 0, 1), field_id: "tag" },
      { ...header(1, "g", "Grace", 1, 1), field_id: "owner" },
      { ...header(0, "chs3", "Done", 2, 2), field_id: status.id },
    ];
    outline({ groups: nested });
    const items = screen.getAllByRole("treeitem");
    expect(items.map((i) => [i.getAttribute("aria-level"), i.textContent])).toEqual([
      ["1", "Todo2"],
      ["2", "Ada1"],
      ["3", "Urgent1"],
      ["2", "Grace1"],
      ["1", "Done2"],
    ]);
  });

  it("collapses a group: its records are hidden, the toggle is reported", async () => {
    const user = userEvent.setup();
    const { props } = outline({ collapsed: new Set([`${status.id}:chs1`]) });
    expect(screen.queryByRole("button", { name: "Write docs" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ship it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Todo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand Todo" }));
    expect(props.onToggle).toHaveBeenCalledWith(`${status.id}:chs1`);
  });

  it("adds a record inside a group with that group's value, and not for readers", async () => {
    const user = userEvent.setup();
    const { props, unmount } = outline();
    await user.click(screen.getByRole("button", { name: "Add record to Todo" }));
    expect(props.onAdd).toHaveBeenCalledWith({ [status.id]: "chs1" });
    await user.click(screen.getByRole("button", { name: "Add record to (Empty)" }));
    expect(props.onAdd).toHaveBeenLastCalledWith({}); // blank group: nothing to prefill
    unmount();
    outline({ canEdit: false });
    expect(screen.queryByRole("button", { name: /^Add record to/ })).not.toBeInTheDocument();
  });

  it("opens a record on click and on Enter, but leaves links alone", async () => {
    const user = userEvent.setup();
    const { props } = outline();
    await user.click(screen.getByRole("button", { name: "Fix bug" }));
    expect(props.onOpen).toHaveBeenCalledWith("r2");
    screen.getByRole("button", { name: "Ship it" }).focus();
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith("r3");
  });

  it("renders a flat list without groups and caps long groups with a show-more button", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: ROWS_PER_GROUP + 30 }, (_, i) => rec(`m${i}`, `Row ${i}`));
    outline({ records: many, groups: [] });
    expect(screen.getByRole("list", { name: "Records" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Row \d+$/ })).toHaveLength(ROWS_PER_GROUP);
    await user.click(screen.getByRole("button", { name: /Show 30 more/ }));
    expect(screen.getAllByRole("button", { name: /^Row \d+$/ })).toHaveLength(ROWS_PER_GROUP + 30);
  });
});

describe("ListOutline keyboard", () => {
  it("makes one heading or row the tab stop", () => {
    outline();
    const stops = [...document.querySelectorAll("[data-nav]")].filter((el) => (el as HTMLElement).tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(screen.getByRole("button", { name: "Collapse Todo" }));
  });

  it("moves between headings and rows with the arrow keys, Home and End", async () => {
    const user = userEvent.setup();
    outline();
    screen.getByRole("button", { name: "Collapse Todo" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Write docs" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("button", { name: "Collapse Done" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "Fix bug" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Idea" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "Collapse Todo" })).toHaveFocus();
    // The row last focused is where Tab comes back to.
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Idea" }).tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Collapse Todo" }).tabIndex).toBe(-1);
  });

  it("folds and unfolds with Left and Right, and Left on a row goes to its heading", async () => {
    const user = userEvent.setup();
    const { props, rerender } = outline();
    screen.getByRole("button", { name: "Collapse Todo" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(props.onToggle).toHaveBeenCalledWith(`${status.id}:chs1`);
    rerender(<ListOutline {...props} collapsed={new Set([`${status.id}:chs1`])} />);
    await user.keyboard("{ArrowRight}");
    expect(props.onToggle).toHaveBeenCalledTimes(2);
    screen.getByRole("button", { name: "Ship it" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Collapse Done" })).toHaveFocus();
  });

  it("skips the rows of a folded group", async () => {
    const user = userEvent.setup();
    outline({ collapsed: new Set([`${status.id}:chs1`]) });
    screen.getByRole("button", { name: "Expand Todo" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Collapse Done" })).toHaveFocus();
  });

  it("opens a row with Enter, selects it with Space and deletes it with Delete", async () => {
    const user = userEvent.setup();
    const selection = fakeSelection();
    const onDelete = vi.fn();
    const { props } = outline({ selection, onDelete });
    screen.getByRole("button", { name: "Fix bug" }).focus();
    await user.keyboard(" ");
    expect(selection.toggle).toHaveBeenCalledWith("r2");
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenCalledWith("r2");
    await user.keyboard("{Delete}");
    expect(onDelete).toHaveBeenCalledWith(["r2"]);
  });

  it("does not delete for people who cannot edit", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    outline({ selection: fakeSelection(), onDelete, canEdit: false });
    screen.getByRole("button", { name: "Fix bug" }).focus();
    await user.keyboard("{Delete}");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("follows a link inside a row on Enter instead of opening the row", async () => {
    const user = userEvent.setup();
    const url = ALL_FIELDS.url!;
    const { props } = outline({ records: [rec("r1", "Site", { [url.id]: "https://example.com" })], groups: [], fields: [url] });
    const link = screen.getByRole("link");
    const click = vi.fn((e: MouseEvent) => e.preventDefault());
    link.addEventListener("click", click);
    link.focus();
    await user.keyboard("{Enter}");
    expect(click).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();
    await user.click(link);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("sends a click to the selection first", async () => {
    const user = userEvent.setup();
    const selection = fakeSelection({ handleClick: vi.fn(() => true) });
    const { props } = outline({ selection });
    await user.click(screen.getByRole("button", { name: "Fix bug" }));
    expect(selection.handleClick).toHaveBeenCalledWith("r2", expect.anything());
    expect(props.onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: "Select Fix bug" }));
    expect(selection.toggle).toHaveBeenCalledWith("r2");
  });

  it("opens the menu on right-click, but leaves a link's own menu alone", () => {
    const onRecordMenu = vi.fn();
    outline({ onRecordMenu });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Fix bug" }), { clientX: 30, clientY: 40 });
    expect(onRecordMenu).toHaveBeenCalledWith("r2", { x: 30, y: 40, width: 1, height: 1 });
  });
});

describe("ListOutline order", () => {
  it("reports Alt+Down as a move after the next row of the same group", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder });
    screen.getByRole("button", { name: "Write docs" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r1", expect.objectContaining({ afterId: "r2", values: {} }));
  });

  it("moves into the next group when it passes the end of its own, taking that group's value", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder });
    screen.getByRole("button", { name: "Fix bug" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r2", expect.objectContaining({ beforeId: "r3", values: { [status.id]: "chs3" } }));
  });

  it("moves up into the previous group after its last row", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder });
    screen.getByRole("button", { name: "Ship it" }).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r3", expect.objectContaining({ afterId: "r2", beforeId: undefined, values: { [status.id]: "chs1" } }));
  });

  it("does nothing without a way to reorder, or for readers", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder, canEdit: false });
    screen.getByRole("button", { name: "Write docs" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("reports that a group made of a field that cannot be written to blocks the move", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder, tableFields: [name, num] });
    screen.getByRole("button", { name: "Fix bug" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r2", "blocked");
  });
});

describe("ListOutline reveal", () => {
  it("draws the open record even when it is past the first rows of its group", () => {
    const many = Array.from({ length: ROWS_PER_GROUP + 30 }, (_, i) => rec(`m${i}`, `Row ${i}`));
    const { props, rerender } = outline({ records: many, groups: [] });
    expect(screen.queryByRole("button", { name: `Row ${ROWS_PER_GROUP + 5}` })).not.toBeInTheDocument();
    rerender(<ListOutline {...props} reveal={`m${ROWS_PER_GROUP + 5}`} />);
    expect(screen.getByRole("button", { name: `Row ${ROWS_PER_GROUP + 5}` })).toBeInTheDocument();
  });
});

