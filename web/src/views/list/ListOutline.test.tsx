import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GroupHeader, TableRecord } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { ListOutline, ROWS_PER_GROUP, type ListOutlineProps } from "./ListOutline";

const name = ALL_FIELDS.single_line_text!;
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

describe("ListOutline", () => {
  it("shows group headers with counts and each group's records, plus a few fields per row", () => {
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

  it("marks a choice group with its colour's dot and shows select values as bare pills", () => {
    outline({ fields: [status, num] });
    expect(screen.getAllByRole("treeitem")[0]!.querySelector(".ob-dot")).not.toBeNull();
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
