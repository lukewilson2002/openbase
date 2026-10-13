import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Filter } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, CHOICES, PEOPLE, field } from "@/test/fields";
import { FilterBuilder } from "./FilterBuilder";

const name = field("single_line_text", {}, { id: "fld_name", name: "Name" });
const qty = field("number", { precision: 0, allow_negative: true }, { id: "fld_qty", name: "Qty" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const due = field("date", { include_time: false, date_format: "us", time_format: "h12", timezone: null }, { id: "fld_due", name: "Due" });
const owner = field("user", { multiple: false, notify: false }, { id: "fld_owner", name: "Owner" });
const fields = [name, qty, status, due, owner, ALL_FIELDS.button];

/** Controlled harness that records every value reported by the builder. */
function Harness({ initial = null, spy, readOnly }: { initial?: Filter | null; spy: (f: Filter | null) => void; readOnly?: boolean }) {
  const [value, setValue] = useState<Filter | null>(initial);
  return (
    <Providers client={createQueryClient()}>
      <FilterBuilder
        value={value}
        readOnly={readOnly}
        fields={fields}
        collaborators={PEOPLE}
        onChange={(f) => {
          spy(f);
          setValue(f);
        }}
      />
    </Providers>
  );
}

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)![0] as Filter | null;

describe("FilterBuilder", () => {
  it("starts empty and adds a condition on the first filterable field", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    expect(screen.getByText("No filters applied to this view.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
    expect(last(spy)).toEqual({ conjunction: "and", items: [{ field_id: "fld_name", op: "contains", value: "" }] });
    expect(screen.getByLabelText("Field")).toHaveValue("fld_name");
  });

  it("does not offer buttons, which cannot be filtered", async () => {
    render(<Harness spy={vi.fn()} initial={{ conjunction: "and", items: [{ field_id: "fld_name", op: "is", value: "x" }] }} />);
    const options = within(screen.getByLabelText("Field")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Name", "Qty", "Status", "Due", "Owner"]);
  });

  it("lists operators for the field type and resets the operand when its shape changes", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ conjunction: "and", items: [{ field_id: "fld_status", op: "is", value: "chs1" }] }} />);
    const ops = within(screen.getByLabelText("Operator")).getAllByRole("option").map((o) => o.textContent);
    expect(ops).toEqual(["is", "is not", "is any of", "is none of", "is empty", "is not empty"]);
    await userEvent.selectOptions(screen.getByLabelText("Operator"), "is_any_of");
    expect(last(spy)).toEqual({ conjunction: "and", items: [{ field_id: "fld_status", op: "is_any_of", value: [] }] });
    await userEvent.selectOptions(screen.getByLabelText("Operator"), "is_empty");
    expect(last(spy)!.items[0]).toMatchObject({ op: "is_empty" });
    expect(screen.queryByLabelText("Option")).not.toBeInTheDocument();
  });

  it("switching to another field type picks that type's first operator", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ conjunction: "and", items: [{ field_id: "fld_name", op: "contains", value: "abc" }] }} />);
    await userEvent.selectOptions(screen.getByLabelText("Field"), "fld_due");
    expect(last(spy)!.items[0]).toEqual({ field_id: "fld_due", op: "is", value: { mode: "today" } });
    await userEvent.selectOptions(screen.getByLabelText("Operator"), "is_within");
    expect(last(spy)!.items[0]).toMatchObject({ op: "is_within", value: { mode: "past_week" } });
  });

  it("uses number operators and parses number operands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ conjunction: "and", items: [{ field_id: "fld_qty", op: "gt", value: "" }] }} />);
    expect(within(screen.getByLabelText("Operator")).getAllByRole("option").map((o) => o.textContent)).toContain("≥");
    await userEvent.type(screen.getByLabelText("Value"), "42", { advanceTimers: vi.advanceTimersByTime });
    await vi.advanceTimersByTimeAsync(600);
    expect(last(spy)!.items[0]).toMatchObject({ op: "gt", value: 42 });
    vi.useRealTimers();
  });

  it("debounces typing in text operands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ conjunction: "and", items: [{ field_id: "fld_name", op: "contains", value: "" }] }} />);
    await userEvent.type(screen.getByLabelText("Value"), "abc", { advanceTimers: vi.advanceTimersByTime });
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(last(spy)!.items[0]).toMatchObject({ value: "abc" });
    vi.useRealTimers();
  });

  it("supports and/or between conditions and nested groups up to 3 levels", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
    await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
    await userEvent.selectOptions(screen.getByLabelText("Match all or any"), "or");
    expect(last(spy)!.conjunction).toBe("or");

    await userEvent.click(screen.getByRole("button", { name: "Add condition group" }));
    // Inside the new group, add a nested group (level 3); the third level cannot nest further.
    // The nested group renders its buttons before the root's.
    const addGroup = screen.getAllByRole("button", { name: "Add condition group" });
    expect(addGroup).toHaveLength(2);
    await userEvent.click(addGroup[0]!);
    // The third level cannot nest further: only the root and level 2 still offer a group.
    expect(screen.getAllByRole("button", { name: "Add condition group" })).toHaveLength(2);
    const f = last(spy)!;
    expect(f.items).toHaveLength(3);
    const lvl2 = f.items[2] as Filter;
    expect(lvl2.items.some((i) => "items" in i)).toBe(true);
  });

  it("removes conditions and reports null when none are left", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ conjunction: "and", items: [{ field_id: "fld_name", op: "is", value: "x" }] }} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove condition" }));
    expect(last(spy)).toBeNull();
  });

  it("offers the current user ('me') for user fields", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ conjunction: "and", items: [{ field_id: "fld_owner", op: "is", value: "" }] }} />);
    expect(within(screen.getByLabelText("Person")).getByRole("option", { name: /Me/ })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Person"), "me");
    expect(last(spy)!.items[0]).toMatchObject({ value: "me" });
  });

  it("is read-only for viewers", () => {
    render(<Harness spy={vi.fn()} readOnly initial={{ conjunction: "and", items: [{ field_id: "fld_name", op: "is", value: "x" }] }} />);
    expect(screen.getByLabelText("Field")).toBeDisabled();
    expect(screen.getByLabelText("Operator")).toBeDisabled();
    expect(screen.getByLabelText("Value")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add condition" })).not.toBeInTheDocument();
  });

  it("flushes a pending text edit when the builder unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    const { unmount } = render(<Harness spy={spy} initial={{ conjunction: "and", items: [{ field_id: "fld_name", op: "contains", value: "" }] }} />);
    await userEvent.type(screen.getByLabelText("Value"), "z", { advanceTimers: vi.advanceTimersByTime });
    unmount();
    expect(last(spy)!.items[0]).toMatchObject({ value: "z" });
    vi.useRealTimers();
  });
});
