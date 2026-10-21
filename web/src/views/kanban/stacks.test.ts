import { describe, expect, it } from "vitest";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import { UNCATEGORIZED, buildStacks, isStackField, moveStackKey, planDrop, recordStackKey, stackKind, stackValue } from "./stacks";

const status = ALL_FIELDS.single_select!; // choices chs1 Todo, chs2 In progress, chs3 Done
const rec = (id: string, v: Record<string, unknown>) => makeRecord(v, id);
const people = [
  { id: "usr1", name: "Ada" },
  { id: "usr2", name: "Grace" },
];

describe("kanban stack fields", () => {
  it("accepts single select, single user and checkbox only", () => {
    expect(stackKind(status)).toBe("select");
    expect(stackKind(field("user", { multiple: false, notify: false }))).toBe("user");
    expect(stackKind(ALL_FIELDS.checkbox)).toBe("checkbox");
    expect(isStackField(ALL_FIELDS.user!)).toBe(false); // multiple
    expect(isStackField(ALL_FIELDS.multiple_select!)).toBe(false);
    expect(isStackField(ALL_FIELDS.text!)).toBe(false);
    expect(stackKind(undefined)).toBeNull();
  });

  it("keys records by choice, treating unknown or missing choices as uncategorized", () => {
    expect(recordStackKey(status, rec("a", { [status.id]: "chs2" }))).toBe("chs2");
    expect(recordStackKey(status, rec("a", { [status.id]: "gone" }))).toBe(UNCATEGORIZED);
    expect(recordStackKey(status, rec("a", {}))).toBe(UNCATEGORIZED);
    const cb = ALL_FIELDS.checkbox!;
    expect(recordStackKey(cb, rec("a", { [cb.id]: true }))).toBe("true");
    expect(recordStackKey(cb, rec("a", {}))).toBe("false");
  });

  it("produces the value a drop writes", () => {
    expect(stackValue(status, "chs3")).toBe("chs3");
    expect(stackValue(status, UNCATEGORIZED)).toBeNull();
    expect(stackValue(field("user", { multiple: false, notify: false }), "usr2")).toEqual(["usr2"]);
    expect(stackValue(ALL_FIELDS.checkbox!, "true")).toBe(true);
    expect(stackValue(ALL_FIELDS.checkbox!, "false")).toBeNull();
  });
});

describe("buildStacks", () => {
  const records = [rec("r1", { [status.id]: "chs3" }), rec("r2", {}), rec("r3", { [status.id]: "chs1" }), rec("r4", { [status.id]: "chs3" })];

  it("lists Uncategorized first, then choices in order, keeping record order inside each stack", () => {
    const stacks = buildStacks(status, records, { stackOrder: [], hideEmpty: false, people });
    expect(stacks.map((s) => s.label)).toEqual(["Uncategorized", "Todo", "In progress", "Done"]);
    expect(stacks.map((s) => s.records.map((r) => r.id))).toEqual([["r2"], ["r3"], [], ["r1", "r4"]]);
    expect(stacks[3]!.color).toBe("green");
    expect(stacks[0]!.uncategorized).toBe(true);
  });

  it("honours stack_order, ignoring unknown keys and appending the rest", () => {
    const stacks = buildStacks(status, records, { stackOrder: ["chs3", "nope", "chs1", "chs3"], hideEmpty: false, people });
    expect(stacks.map((s) => s.key)).toEqual(["chs3", "chs1", UNCATEGORIZED, "chs2"]);
  });

  it("hides empty stacks on request", () => {
    const stacks = buildStacks(status, records, { stackOrder: [], hideEmpty: true, people });
    expect(stacks.map((s) => s.label)).toEqual(["Uncategorized", "Todo", "Done"]);
    expect(buildStacks(status, [rec("x", { [status.id]: "chs1" })], { stackOrder: [], hideEmpty: true, people }).map((s) => s.label)).toEqual(["Todo"]);
  });

  it("leaves out an empty Uncategorized stack, which nobody chose", () => {
    const stacks = buildStacks(status, [rec("x", { [status.id]: "chs1" })], { stackOrder: [], hideEmpty: false, people });
    expect(stacks.map((s) => s.label)).toEqual(["Todo", "In progress", "Done"]);
  });

  it("stacks by user: every collaborator gets a stack, plus unknown holders", () => {
    const user = field("user", { multiple: false, notify: false }, { id: "fld_owner" });
    const stacks = buildStacks(user, [rec("a", { fld_owner: ["usr2"] }), rec("b", { fld_owner: ["ghost"] })], { stackOrder: [], hideEmpty: false, people });
    expect(stacks.map((s) => [s.key, s.label, s.records.length])).toEqual([
      ["usr1", "Ada", 0],
      ["usr2", "Grace", 1],
      ["ghost", "ghost", 1],
    ]);
  });

  it("stacks a checkbox into unchecked and checked", () => {
    const cb = ALL_FIELDS.checkbox!;
    const stacks = buildStacks(cb, [rec("a", { [cb.id]: true }), rec("b", {})], { stackOrder: [], hideEmpty: false, people });
    expect(stacks.map((s) => [s.label, s.records.length])).toEqual([
      ["Unchecked", 1],
      ["Checked", 1],
    ]);
  });

  it("returns nothing for a field that cannot stack", () => {
    expect(buildStacks(ALL_FIELDS.number!, records, { stackOrder: [], hideEmpty: false, people })).toEqual([]);
  });
});

describe("moveStackKey", () => {
  it("swaps a stack with its neighbour and stays put at the ends", () => {
    expect(moveStackKey(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveStackKey(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveStackKey(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveStackKey(["a", "b", "c"], "z", 1)).toEqual(["a", "b", "c"]);
  });
});

describe("planDrop", () => {
  it("writes the field and anchors before the next card when changing stacks", () => {
    const plan = planDrop({ recordId: "r1", fromKey: "a", toKey: "b", fromIds: ["r1", "r2"], targetIds: ["r5", "r1", "r6"], hasSorts: false });
    expect(plan).toEqual({ recordId: "r1", fromKey: "a", toKey: "b", changeValue: true, anchor: { beforeId: "r6" } });
  });

  it("anchors after the previous card when dropped last, and not at all into an empty stack", () => {
    expect(planDrop({ recordId: "r1", fromKey: "a", toKey: "b", fromIds: ["r1"], targetIds: ["r5", "r1"], hasSorts: false })?.anchor).toEqual({ afterId: "r5" });
    expect(planDrop({ recordId: "r1", fromKey: "a", toKey: "b", fromIds: ["r1"], targetIds: ["r1"], hasSorts: false })?.anchor).toBeNull();
  });

  it("reorders inside a stack only without sorts and only when the position changed", () => {
    expect(planDrop({ recordId: "r1", fromKey: "a", toKey: "a", fromIds: ["r1", "r2", "r3"], targetIds: ["r2", "r3", "r1"], hasSorts: false })).toEqual({
      recordId: "r1",
      fromKey: "a",
      toKey: "a",
      changeValue: false,
      anchor: { afterId: "r3" },
    });
    expect(planDrop({ recordId: "r1", fromKey: "a", toKey: "a", fromIds: ["r1", "r2"], targetIds: ["r1", "r2"], hasSorts: false })).toBeNull();
    expect(planDrop({ recordId: "r1", fromKey: "a", toKey: "a", fromIds: ["r1", "r2", "r3"], targetIds: ["r2", "r3", "r1"], hasSorts: true })).toBeNull();
  });

  it("with sorts, a cross-stack drop only changes the field", () => {
    expect(planDrop({ recordId: "r1", fromKey: "a", toKey: "b", fromIds: ["r1"], targetIds: ["r5", "r1"], hasSorts: true })).toEqual({ recordId: "r1", fromKey: "a", toKey: "b", changeValue: true, anchor: null });
  });

  it("ignores a drop whose card is not in the target", () => {
    expect(planDrop({ recordId: "r1", fromKey: "a", toKey: "b", fromIds: ["r1"], targetIds: ["r5"], hasSorts: false })).toBeNull();
  });
});
