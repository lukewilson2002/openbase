import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GroupHeader, TableRecord } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import type { RecordSelection } from "../common/useRecordSelection";
import { ListOutline, ROWS_PER_GROUP, type ListOutlineProps } from "./ListOutline";

const name = ALL_FIELDS.text!;
const status = ALL_FIELDS.single_select!;
const num = ALL_FIELDS.number!;

const rec = (id: string, title: string, v: Record<string, unknown> = {}): TableRecord => makeRecord({ [name.id]: title, ...v }, id);
const records = [rec("r1", "Write docs", { [status.id]: "chs1", [num.id]: 3 }), rec("r2", "Fix bug", { [status.id]: "chs1" }), rec("r3", "Ship it", { [status.id]: "chs3" }), rec("r4", "Idea", {})];
const header = (depth: number, key: string, label: string, start: number, count: number, value: unknown = key): GroupHeader => ({ depth, field_id: status.id, key, label, value: value as GroupHeader["value"], start, count });
const groups = [header(0, "chs1", "Todo", 0, 2), header(0, "chs3", "Done", 2, 1), header(0, "", "(Empty)", 3, 1, null)];

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A record's row: a tree item named with its title first, then its values. */
const row = (title: string) => screen.getByRole("treeitem", { name: new RegExp(`^${esc(title)}(,|$)`) });
const queryRow = (title: string) => screen.queryByRole("treeitem", { name: new RegExp(`^${esc(title)}(,|$)`) });
/** A group's heading: a tree item named with the group's label and its count. */
const head = (label: string) => screen.getByRole("treeitem", { name: new RegExp(`^${esc(label)}, \\d+ records?$`) });

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
    const headers = within(tree).getAllByRole("treeitem", { name: /, \d+ records?$/ });
    expect(headers.map((h) => h.textContent)).toEqual(["Todo2", "Done1", "(Empty)1"]);
    expect(head("Todo")).toBeInTheDocument();
    expect(headers[0]).toHaveAttribute("aria-expanded", "true");
    // Records sit under their group in order, with the number field shown when set.
    const first = row("Write docs");
    expect(within(first).getByText("number")).toBeInTheDocument();
    expect(within(first).getByText("3.00")).toBeInTheDocument();
    expect(first.querySelector("[data-row-color='red']")).not.toBeNull();
    expect(screen.getAllByRole("treeitem", { name: /^(Write docs|Fix bug|Ship it|Idea)(,|$)/ })).toHaveLength(4);
  });

  it("shows every field the view shows that has a value, not just the first few, and leaves empty ones out", () => {
    const extra = [ALL_FIELDS.email!, ALL_FIELDS.url!, ALL_FIELDS.percent!, ALL_FIELDS.currency!];
    const full = rec("r9", "Everything", { [num.id]: 3, [extra[0]!.id]: "a@b.co", [extra[1]!.id]: "https://example.com", [extra[2]!.id]: 0.5, [extra[3]!.id]: null });
    outline({ records: [full], groups: [], fields: [num, ...extra] });
    const everything = row("Everything");
    for (const f of [num, extra[0]!, extra[1]!, extra[2]!]) expect(within(everything).getByText(f.name)).toBeInTheDocument();
    expect(within(everything).queryByText(extra[3]!.name)).not.toBeInTheDocument();
  });

  it("fills a choice group's heading with its colour (no dot) and shows select values as bare pills", () => {
    outline({ fields: [status, num] });
    const heading = head("Todo");
    expect(heading).toHaveClass("ob-fill");
    expect(heading.querySelector(".ob-dot")).toBeNull();
    const first = row("Write docs");
    expect(within(first).queryByText(status.name)).not.toBeInTheDocument();
    expect(within(first).getByText("number")).toBeInTheDocument();
  });

  it("puts the person's face on a person group", () => {
    const owner = ALL_FIELDS.user!;
    outline({ groups: [{ ...header(0, "usr1", "Ada Lovelace", 0, 4, ["usr1"]), field_id: owner.id }], tableFields: [name, owner] });
    expect(head("Ada Lovelace").querySelector("[role=img]")).toHaveTextContent("AL");
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
    const items = screen.getAllByRole("treeitem", { name: /, \d+ records?$/ });
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
    expect(queryRow("Write docs")).not.toBeInTheDocument();
    expect(row("Ship it")).toBeInTheDocument();
    expect(head("Todo")).toBeInTheDocument();
    await user.click(head("Todo"));
    expect(props.onToggle).toHaveBeenCalledWith(`${status.id}:chs1`);
  });

  it("adds a record inside a group with that group's value, and not for readers", async () => {
    const user = userEvent.setup();
    const { props, unmount } = outline();
    await user.click(screen.getByRole("treeitem", { name: "Add record to Todo" }));
    expect(props.onAdd).toHaveBeenCalledWith({ [status.id]: "chs1" });
    await user.click(screen.getByRole("treeitem", { name: "Add record to (Empty)" }));
    expect(props.onAdd).toHaveBeenLastCalledWith({}); // blank group: nothing to prefill
    unmount();
    outline({ canEdit: false });
    expect(screen.queryByRole("treeitem", { name: /^Add record to/ })).not.toBeInTheDocument();
  });

  it("opens a record on click and on Enter, but leaves links alone", async () => {
    const user = userEvent.setup();
    const { props } = outline();
    await user.click(row("Fix bug"));
    expect(props.onOpen).toHaveBeenCalledWith("r2");
    row("Ship it").focus();
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith("r3");
  });

  it("renders a flat list without groups and caps long groups with a show-more button", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: ROWS_PER_GROUP + 30 }, (_, i) => rec(`m${i}`, `Row ${i}`));
    outline({ records: many, groups: [] });
    expect(screen.getByRole("tree", { name: "Records" })).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem", { name: /^Row \d+$/ })).toHaveLength(ROWS_PER_GROUP);
    await user.click(screen.getByRole("treeitem", { name: /Show 30 more/ }));
    expect(screen.getAllByRole("treeitem", { name: /^Row \d+$/ })).toHaveLength(ROWS_PER_GROUP + 30);
  });
});

describe("ListOutline keyboard", () => {
  it("makes one heading or row the tab stop", () => {
    outline();
    const stops = [...document.querySelectorAll("[data-nav]")].filter((el) => (el as HTMLElement).tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(head("Todo"));
  });

  it("moves between headings and rows with the arrow keys, Home and End", async () => {
    const user = userEvent.setup();
    outline();
    head("Todo").focus();
    await user.keyboard("{ArrowDown}");
    expect(row("Write docs")).toHaveFocus();
    // After the group's rows comes its Add line, then the next heading.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("treeitem", { name: "Add record to Todo" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(head("Done")).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(row("Fix bug")).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("treeitem", { name: "Add record to (Empty)" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(row("Idea")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(head("Todo")).toHaveFocus();
    // The row last focused is where Tab comes back to.
    await user.keyboard("{End}{ArrowUp}");
    expect(row("Idea").tabIndex).toBe(0);
    expect(head("Todo").tabIndex).toBe(-1);
  });

  it("folds and unfolds with Left and Right, and Left on a row goes to its heading", async () => {
    const user = userEvent.setup();
    const { props, rerender } = outline();
    head("Todo").focus();
    await user.keyboard("{ArrowLeft}");
    expect(props.onToggle).toHaveBeenCalledWith(`${status.id}:chs1`);
    rerender(<ListOutline {...props} collapsed={new Set([`${status.id}:chs1`])} />);
    await user.keyboard("{ArrowRight}");
    expect(props.onToggle).toHaveBeenCalledTimes(2);
    row("Ship it").focus();
    await user.keyboard("{ArrowLeft}");
    expect(head("Done")).toHaveFocus();
  });

  it("skips the rows of a folded group", async () => {
    const user = userEvent.setup();
    outline({ collapsed: new Set([`${status.id}:chs1`]) });
    head("Todo").focus();
    await user.keyboard("{ArrowDown}");
    expect(head("Done")).toHaveFocus();
  });

  it("opens a row with Enter, selects it with Space and deletes it with Delete", async () => {
    const user = userEvent.setup();
    const selection = fakeSelection();
    const onDelete = vi.fn();
    const { props } = outline({ selection, onDelete });
    row("Fix bug").focus();
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
    row("Fix bug").focus();
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
    await user.click(row("Fix bug"));
    expect(selection.handleClick).toHaveBeenCalledWith("r2", expect.anything());
    expect(props.onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: "Select Fix bug" }));
    expect(selection.toggle).toHaveBeenCalledWith("r2");
  });

  it("opens the menu on right-click, but leaves a link's own menu alone", () => {
    const onRecordMenu = vi.fn();
    outline({ onRecordMenu });
    fireEvent.contextMenu(row("Fix bug"), { clientX: 30, clientY: 40 });
    expect(onRecordMenu).toHaveBeenCalledWith("r2", { x: 30, y: 40, width: 1, height: 1 }, {});
  });
});

describe("ListOutline order", () => {
  it("reports Alt+Down as a move after the next row of the same group", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder });
    row("Write docs").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r1", expect.objectContaining({ afterId: "r2", values: {} }));
  });

  it("moves into the next group when it passes the end of its own, taking that group's value", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder });
    row("Fix bug").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r2", expect.objectContaining({ beforeId: "r3", values: { [status.id]: "chs3" } }));
  });

  it("moves up into the previous group after its last row", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder });
    row("Ship it").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r3", expect.objectContaining({ afterId: "r2", beforeId: undefined, values: { [status.id]: "chs1" } }));
  });

  it("does nothing without a way to reorder, or for readers", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder, canEdit: false });
    row("Write docs").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("reports that a group made of a field that cannot be written to blocks the move", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    outline({ onReorder, tableFields: [name, num] });
    row("Fix bug").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("r2", "blocked");
  });
});

describe("ListOutline reveal", () => {
  it("draws the open record even when it is past the first rows of its group", () => {
    const many = Array.from({ length: ROWS_PER_GROUP + 30 }, (_, i) => rec(`m${i}`, `Row ${i}`));
    const { props, rerender } = outline({ records: many, groups: [] });
    expect(queryRow(`Row ${ROWS_PER_GROUP + 5}`)).not.toBeInTheDocument();
    rerender(<ListOutline {...props} reveal={`m${ROWS_PER_GROUP + 5}`} />);
    expect(row(`Row ${ROWS_PER_GROUP + 5}`)).toBeInTheDocument();
  });
});


describe("ListOutline tree", () => {
  it("is a tree of tree items: headings with their level, place and fold state, rows named with their values", () => {
    outline({ fields: [num] });
    const tree = screen.getByRole("tree", { name: "Grouped records" });
    expect(within(tree).queryAllByRole("button")).toHaveLength(0);
    expect(within(tree).queryByRole("list")).not.toBeInTheDocument();
    expect(head("Done")).toHaveAttribute("aria-level", "1");
    expect(head("Done")).toHaveAttribute("aria-posinset", "2");
    expect(head("Done")).toHaveAttribute("aria-setsize", "3");
    expect(head("Done")).toHaveAttribute("aria-expanded", "true");
    // A record is one level below its group, and its name carries the values the row shows.
    const first = within(tree).getByRole("treeitem", { name: `Write docs, ${num.name}: 3.00` });
    expect(first).toHaveAttribute("aria-level", "2");
    expect(first).toHaveAttribute("aria-posinset", "1");
    expect(first).toHaveAttribute("aria-setsize", "2");
    expect(row("Fix bug")).toHaveAccessibleName("Fix bug");
  });

  it("names a row with its description and its select values too", () => {
    const notes = field("text", { multiline: true }, { id: "f_notes", name: "Notes" });
    outline({ records: [rec("r1", "Write docs", { [status.id]: "chs3", [notes.id]: "First draft" })], groups: [], fields: [status], descriptionField: notes, tableFields: [name, status, notes] });
    expect(screen.getByRole("treeitem", { name: `Write docs, ${status.name}: Done, First draft` })).toBeInTheDocument();
  });

  it("draws an ungrouped list as a tree of rows, with the selection announced", () => {
    outline({ groups: [], selection: fakeSelection({ has: (id) => id === "r2", count: 1 }) });
    const tree = screen.getByRole("tree", { name: "Records" });
    expect(tree).toHaveAttribute("aria-multiselectable", "true");
    expect(row("Fix bug")).toHaveAttribute("aria-level", "1");
    expect(row("Fix bug")).toHaveAttribute("aria-selected", "true");
    expect(row("Idea")).toHaveAttribute("aria-selected", "false");
    expect(row("Idea")).toHaveAttribute("aria-setsize", "4");
  });

  it("folds a group from its heading with the mouse, Enter or Space, and adds from the Add line with Enter", async () => {
    const user = userEvent.setup();
    const { props } = outline();
    await user.click(head("Todo"));
    expect(props.onToggle).toHaveBeenLastCalledWith(`${status.id}:chs1`);
    head("Done").focus();
    await user.keyboard("{Enter}");
    expect(props.onToggle).toHaveBeenLastCalledWith(`${status.id}:chs3`);
    await user.keyboard(" ");
    expect(props.onToggle).toHaveBeenCalledTimes(3);
    screen.getByRole("treeitem", { name: "Add record to Todo" }).focus();
    await user.keyboard("{Enter}");
    expect(props.onAdd).toHaveBeenCalledWith({ [status.id]: "chs1" });
  });

  it("makes the Add line of a group and Show more tree items too", () => {
    const many = Array.from({ length: ROWS_PER_GROUP + 3 }, (_, i) => rec(`m${i}`, `Row ${i}`, { [status.id]: "chs1" }));
    outline({ records: many, groups: [header(0, "chs1", "Todo", 0, many.length)] });
    expect(screen.getByRole("treeitem", { name: "Show 3 more records" })).toHaveAttribute("aria-level", "2");
    expect(screen.getByRole("treeitem", { name: "Add record to Todo" })).toHaveAttribute("aria-level", "2");
  });
});

describe("ListOutline prefix", () => {
  const done = ALL_FIELDS.checkbox!;
  const withDone = [rec("r1", "Write docs", { [done.id]: true }), rec("r2", "Fix bug", {}), rec("r3", "Ship it", { [done.id]: null })];

  it("draws a checkbox on every row, ticked or not, named for its field and row", () => {
    outline({ records: withDone, groups: [], prefix: done, fields: [], tableFields: [name, done], onPrefixChange: vi.fn() });
    const boxes = screen.getAllByRole("checkbox", { name: /^checkbox: / });
    expect(boxes.map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-checked")])).toEqual([
      ["checkbox: Write docs", "true"],
      ["checkbox: Fix bug", "false"],
      ["checkbox: Ship it", "false"],
    ]);
    // The row says it too, to a screen reader.
    expect(row("Write docs")).toHaveAccessibleName("Write docs, checkbox: checked");
    expect(row("Fix bug")).toHaveAccessibleName("Fix bug, checkbox: unchecked");
  });

  it("ticks a box in place without opening the row, and unticks it", async () => {
    const user = userEvent.setup();
    const onPrefixChange = vi.fn();
    const { props } = outline({ records: withDone, groups: [], prefix: done, fields: [], onPrefixChange });
    await user.click(screen.getByRole("checkbox", { name: "checkbox: Fix bug" }));
    expect(onPrefixChange).toHaveBeenCalledWith("r2", true);
    await user.click(screen.getByRole("checkbox", { name: "checkbox: Write docs" }));
    expect(onPrefixChange).toHaveBeenLastCalledWith("r1", null);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("ticks the focused row's box with Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const onPrefixChange = vi.fn();
    const { props } = outline({ records: withDone, groups: [], prefix: done, fields: [], onPrefixChange });
    row("Fix bug").focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onPrefixChange).toHaveBeenCalledWith("r2", true);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("shows the box but does not change it for people who cannot edit", async () => {
    const user = userEvent.setup();
    const onPrefixChange = vi.fn();
    outline({ records: withDone, groups: [], prefix: done, fields: [], canEdit: false, onPrefixChange });
    const box = screen.getByRole("checkbox", { name: "checkbox: Fix bug" });
    expect(box).toHaveAttribute("aria-disabled", "true");
    await user.click(box);
    expect(onPrefixChange).not.toHaveBeenCalled();
  });

  it("picks a choice from the pill at the start of the row", async () => {
    const user = userEvent.setup();
    const onPrefixChange = vi.fn();
    const { props } = outline({ groups: [], prefix: status, fields: [], onPrefixChange });
    expect(screen.getByRole("button", { name: "single_select: Write docs, Todo" })).toHaveTextContent("Todo");
    await user.click(screen.getByRole("button", { name: "single_select: Idea, none" }));
    await user.click(await screen.findByRole("menuitem", { name: "Done" }));
    expect(onPrefixChange).toHaveBeenCalledWith("r4", "chs3");
    // Clearing a value is in the menu too.
    await user.click(screen.getByRole("button", { name: "single_select: Fix bug, Todo" }));
    await user.click(await screen.findByRole("menuitem", { name: "No value" }));
    expect(onPrefixChange).toHaveBeenLastCalledWith("r2", null);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("picks a person from the face at the start of the row", async () => {
    const user = userEvent.setup();
    const owner = field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" });
    const onPrefixChange = vi.fn();
    const people = [{ id: "usr1", name: "Ada Lovelace", email: "ada@example.com" }, { id: "usr2", name: "Grace Hopper", email: "grace@example.com" }];
    const { props } = outline({ records: [rec("r1", "Write docs", { [owner.id]: ["usr1"] })], groups: [], prefix: owner, fields: [], people, onPrefixChange, tableFields: [name, owner] });
    await user.click(screen.getByRole("button", { name: "Owner: Write docs, Ada Lovelace" }));
    await user.click(await screen.findByRole("menuitem", { name: /Grace Hopper/ }));
    expect(onPrefixChange).toHaveBeenCalledWith("r1", ["usr2"]);
    expect(props.onOpen).not.toHaveBeenCalled();
  });
});

describe("ListOutline sub-items", () => {
  const P = "f_parent";
  const parent = field("link", { linked_table_id: "tbl1", inverse_field_id: "f_children", single: false }, { id: P, name: "Parent" });
  const child = (id: string, title: string, of?: string) => rec(id, title, of ? { [P]: [{ id: of, name: of }] } : {});
  // Plan -> Design, Build -> Wire (Build is Design's sibling), Ship is its own item.
  const tasks = [child("a", "Plan"), child("b", "Design", "a"), child("c", "Wire", "b"), child("d", "Build", "a"), child("e", "Ship")];
  const nested = (over: Partial<ListOutlineProps> = {}) => outline({ records: tasks, groups: [], fields: [], parentField: parent, folded: new Set(), onToggleFold: vi.fn(), onSetParent: vi.fn(), tableFields: [name, parent], ...over });

  it("draws a sub-item under its parent, one level deeper, in the view's order", () => {
    nested();
    const items = screen.getAllByRole("treeitem");
    expect(items.map((i) => [i.getAttribute("aria-label"), i.getAttribute("aria-level"), i.getAttribute("aria-expanded")])).toEqual([
      ["Plan", "1", "true"],
      ["Design", "2", "true"],
      ["Wire", "3", null],
      ["Build", "2", null],
      ["Ship", "1", null],
    ]);
    expect(row("Build")).toHaveAttribute("aria-posinset", "2");
    expect(row("Build")).toHaveAttribute("aria-setsize", "2");
  });

  it("folds a row's sub-items from its arrow and shows how many are tucked away", async () => {
    const user = userEvent.setup();
    const onToggleFold = vi.fn();
    const { props, rerender } = nested({ onToggleFold });
    await user.click(within(row("Plan")).getByText((_, el) => el?.hasAttribute("data-fold") ?? false));
    expect(onToggleFold).toHaveBeenCalledWith("a");
    expect(props.onOpen).not.toHaveBeenCalled();
    rerender(<ListOutline {...props} folded={new Set(["a"])} />);
    expect(queryRow("Design")).not.toBeInTheDocument();
    expect(queryRow("Build")).not.toBeInTheDocument();
    expect(row("Plan")).toHaveAttribute("aria-expanded", "false");
    expect(row("Plan")).toHaveTextContent("2");
    expect(row("Ship")).toBeInTheDocument();
  });

  it("folds and unfolds with Left and Right, and Left goes to the parent", async () => {
    const user = userEvent.setup();
    const onToggleFold = vi.fn();
    const { props, rerender } = nested({ onToggleFold });
    row("Design").focus();
    await user.keyboard("{ArrowLeft}");
    expect(onToggleFold).toHaveBeenCalledWith("b");
    // A sub-item without sub-items of its own: Left climbs to its parent.
    row("Build").focus();
    await user.keyboard("{ArrowLeft}");
    expect(row("Plan")).toHaveFocus();
    rerender(<ListOutline {...props} folded={new Set(["a"])} />);
    await user.keyboard("{ArrowRight}");
    expect(onToggleFold).toHaveBeenLastCalledWith("a");
    rerender(<ListOutline {...props} folded={new Set()} />);
    await user.keyboard("{ArrowRight}");
    expect(row("Design")).toHaveFocus();
  });

  it("indents a row under the row above it with Tab, and outdents it with Shift+Tab", async () => {
    const user = userEvent.setup();
    const onSetParent = vi.fn();
    nested({ onSetParent });
    row("Ship").focus();
    await user.keyboard("{Tab}");
    expect(onSetParent).toHaveBeenCalledWith("e", [{ id: "a", name: "Plan" }], "Indent");
    row("Wire").focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(onSetParent).toHaveBeenLastCalledWith("c", [{ id: "a", name: "a" }], "Outdent");
    row("Design").focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(onSetParent).toHaveBeenLastCalledWith("b", [], "Outdent");
    expect(onSetParent).toHaveBeenCalledTimes(3);
  });

  it("lets Tab move on where a row cannot be indented or outdented", async () => {
    const user = userEvent.setup();
    const onSetParent = vi.fn();
    nested({ onSetParent });
    // The first row has nothing above it to go under; a top-level row has nothing to move out of.
    row("Plan").focus();
    const first = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    row("Plan").dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    row("Ship").dispatchEvent(back);
    expect(back.defaultPrevented).toBe(false);
    await user.keyboard("{Tab}");
    expect(onSetParent).not.toHaveBeenCalled();
  });

  it("does not indent for people who cannot edit", () => {
    const onSetParent = vi.fn();
    nested({ canEdit: false, onSetParent });
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    row("Ship").dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(onSetParent).not.toHaveBeenCalled();
  });

  it("offers indent, outdent and a new sub-item to a row's menu", () => {
    const onRecordMenu = vi.fn();
    const onAdd = vi.fn();
    nested({ onRecordMenu, onAdd });
    fireEvent.contextMenu(row("Build"), { clientX: 5, clientY: 6 });
    const tree = onRecordMenu.mock.calls[0]![2];
    expect(tree.indent).toBeDefined(); // under Design
    expect(tree.outdent).toBeDefined();
    tree.addSub();
    expect(onAdd).toHaveBeenCalledWith({ [P]: [{ id: "d", name: "Build" }] });
    fireEvent.contextMenu(row("Plan"), { clientX: 5, clientY: 6 });
    expect(onRecordMenu.mock.calls[1]![2].indent).toBeUndefined();
    expect(onRecordMenu.mock.calls[1]![2].outdent).toBeUndefined();
  });

  it("opens the parent a row is indented under, so the row does not vanish", async () => {
    const user = userEvent.setup();
    const onToggleFold = vi.fn();
    nested({ folded: new Set(["a"]), onToggleFold });
    row("Ship").focus();
    await user.keyboard("{Tab}");
    expect(onToggleFold).toHaveBeenCalledWith("a");
  });

  it("keeps sub-items inside their group, and a record whose parent is in another group is top-level there", () => {
    const g = [header(0, "chs1", "Todo", 0, 2), header(0, "chs3", "Done", 2, 1)];
    const rows = [rec("a", "Plan", { [status.id]: "chs1" }), rec("b", "Design", { [status.id]: "chs1", [P]: [{ id: "a", name: "Plan" }] }), rec("c", "Wire", { [status.id]: "chs3", [P]: [{ id: "a", name: "Plan" }] })];
    outline({ records: rows, groups: g, fields: [], parentField: parent, folded: new Set(), tableFields: [name, status, parent] });
    expect(row("Design")).toHaveAttribute("aria-level", "3");
    expect(row("Wire")).toHaveAttribute("aria-level", "2");
  });

  it("opens the folded parents above the record that is opened, once", () => {
    const onToggleFold = vi.fn();
    const { props, rerender } = nested({ folded: new Set(["a", "b"]), onToggleFold });
    expect(queryRow("Wire")).not.toBeInTheDocument();
    rerender(<ListOutline {...props} reveal="c" />);
    expect(onToggleFold.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    // A parent folded again by hand while the record stays open is left alone.
    rerender(<ListOutline {...props} reveal="c" records={[...tasks]} />);
    expect(onToggleFold).toHaveBeenCalledTimes(2);
  });

  it("makes a row dropped by Alt+Down a sibling of the row it passes", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    nested({ onReorder });
    // Ship passes Plan's whole family to the top-level row above... Build is the last row of Plan's tree.
    row("Ship").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("e", expect.objectContaining({ beforeId: "d", values: { [P]: [{ id: "a", name: "a" }] } }));
  });

  it("does not make a record a sub-item of its own sub-item", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    nested({ onReorder });
    // Plan moving down past Design would take Design's parent (Plan itself).
    row("Plan").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).toHaveBeenCalledWith("a", expect.objectContaining({ values: {} }));
  });
});

describe("ListOutline rows past the loaded records", () => {
  const g = [header(0, "chs1", "Todo", 0, 2), header(0, "chs3", "Done", 40, 40)];
  const loaded = new Map([["fld_single_select:chs1", 2], ["fld_single_select:chs3", 0]]);

  it("asks for the rows of an open group that are not loaded and says they are on their way", () => {
    const onNeedRows = vi.fn();
    outline({ records: records.slice(0, 2), groups: g, loadedRows: loaded, onNeedRows, rowStatus: "loading" });
    expect(onNeedRows).toHaveBeenCalledTimes(1);
    expect(onNeedRows).toHaveBeenCalledWith("fld_single_select:chs3", 40);
    expect(screen.getByRole("treeitem", { name: "Loading records" })).toHaveAttribute("aria-busy", "true");
    // A group that has all its rows asks for nothing.
    expect(onNeedRows).not.toHaveBeenCalledWith("fld_single_select:chs1", expect.anything());
  });

  it("does not ask for the rows of a folded group", () => {
    const onNeedRows = vi.fn();
    outline({ records: records.slice(0, 2), groups: g, loadedRows: loaded, onNeedRows, collapsed: new Set(["fld_single_select:chs3"]) });
    expect(onNeedRows).not.toHaveBeenCalled();
  });

  it("asks for no more than a page of a big group, and for the next page when Show more is pressed", async () => {
    const user = userEvent.setup();
    const onNeedRows = vi.fn();
    const big = [header(0, "chs1", "Todo", 0, 500)];
    const some = Array.from({ length: ROWS_PER_GROUP }, (_, i) => rec(`m${i}`, `Row ${i}`));
    const { props, rerender } = outline({ records: some, groups: big, loadedRows: new Map([["fld_single_select:chs1", ROWS_PER_GROUP]]), onNeedRows });
    expect(onNeedRows).not.toHaveBeenCalled();
    await user.click(screen.getByRole("treeitem", { name: `Show ${ROWS_PER_GROUP} more records` }));
    expect(onNeedRows).toHaveBeenCalledWith("fld_single_select:chs1", ROWS_PER_GROUP * 2);
    expect(screen.getByRole("treeitem", { name: "Loading records" })).toBeInTheDocument();
    // The rows arrive and are drawn.
    const more = [...some, ...Array.from({ length: ROWS_PER_GROUP }, (_, i) => rec(`n${i}`, `More ${i}`))];
    rerender(<ListOutline {...props} records={more} loadedRows={new Map([["fld_single_select:chs1", more.length]])} onNeedRows={onNeedRows} />);
    expect(screen.queryByRole("treeitem", { name: "Loading records" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("treeitem", { name: /^More \d+$/ })).toHaveLength(ROWS_PER_GROUP);
    expect(screen.getByRole("treeitem", { name: "Show 100 more records" })).toBeInTheDocument();
  });

  it("says it could not load them and tries again from the line", async () => {
    const user = userEvent.setup();
    const onRetryRows = vi.fn();
    outline({ records: records.slice(0, 2), groups: g, loadedRows: loaded, rowStatus: "error", onRetryRows, onNeedRows: vi.fn() });
    await user.click(screen.getByRole("treeitem", { name: /Could not load/ }));
    expect(onRetryRows).toHaveBeenCalledTimes(1);
  });
});
