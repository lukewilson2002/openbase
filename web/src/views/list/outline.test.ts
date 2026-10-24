import { describe, expect, it } from "vitest";
import type { GroupHeader } from "@/api/types";
import type { TableRecord } from "@/api/types";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { allPaths, buildOutline, flattenOutline, foldRows, foldedAncestors, groupDefaults, indentTarget, leafNodes, moveBetweenGroups, nestRows, outdentValue, parentLinkOf, placeIndexes, planDrop, rowLabel, visibleIds, withTails, type DropPlan } from "./outline";

const h = (depth: number, field_id: string, key: string, start: number, count: number, value: unknown = key): GroupHeader => ({ depth, field_id, key, label: key || "(Empty)", value: value as GroupHeader["value"], start, count });

// Status (todo: 3 -> owners ada 2 / grace 1, done: 2 -> owners ada 2), then an empty status group of 1.
const groups = [h(0, "st", "todo", 0, 3), h(1, "ow", "ada", 0, 2), h(1, "ow", "grace", 2, 1), h(0, "st", "done", 3, 2), h(1, "ow", "ada", 3, 2), h(0, "st", "", 5, 1, null)];

describe("buildOutline", () => {
  it("nests headers by depth and keeps record ranges", () => {
    const tree = buildOutline(groups);
    expect(tree.map((n) => [n.header.key, n.start, n.count, n.children.length])).toEqual([
      ["todo", 0, 3, 2],
      ["done", 3, 2, 1],
      ["", 5, 1, 0],
    ]);
    expect(tree[0]!.children.map((c) => [c.header.key, c.start, c.count])).toEqual([
      ["ada", 0, 2],
      ["grace", 2, 1],
    ]);
  });

  it("gives equal keys under different parents distinct paths", () => {
    const tree = buildOutline(groups);
    expect(tree[0]!.children[0]!.path).toBe("st:todo/ow:ada");
    expect(tree[1]!.children[0]!.path).toBe("st:done/ow:ada");
    expect(allPaths(tree)).toEqual(["st:todo", "st:todo/ow:ada", "st:todo/ow:grace", "st:done", "st:done/ow:ada", "st:", ]);
  });

  it("returns nothing without groups", () => {
    expect(buildOutline([])).toEqual([]);
  });
});

describe("flattenOutline", () => {
  it("emits group rows with their record ranges under the deepest level", () => {
    const rows = flattenOutline(buildOutline(groups), new Set());
    expect(rows.map((r) => `${r.kind}:${r.depth}:${r.node.header.key}`)).toEqual([
      "group:0:todo",
      "group:1:ada",
      "records:2:ada",
      "group:1:grace",
      "records:2:grace",
      "group:0:done",
      "group:1:ada",
      "records:2:ada",
      "group:0:",
      "records:1:",
    ]);
  });

  it("hides everything inside a collapsed group", () => {
    const rows = flattenOutline(buildOutline(groups), new Set(["st:todo", "st:done/ow:ada"]));
    expect(rows.map((r) => `${r.kind}:${r.node.header.key}`)).toEqual(["group:todo", "group:done", "group:ada", "group:", "records:"]);
    expect(rows.find((r) => r.kind === "group" && r.node.path === "st:todo")).toMatchObject({ collapsed: true });
  });
});

describe("groupDefaults", () => {
  it("collects one value per level and skips blank groups", () => {
    const tree = buildOutline(groups);
    expect(groupDefaults(tree[0]!.children[1]!)).toEqual({ st: "todo", ow: "grace" });
    expect(groupDefaults(tree[0]!)).toEqual({ st: "todo" });
    expect(groupDefaults(tree[2]!)).toEqual({});
  });
});

// Six records r0..r5 laid out as `groups` above: todo/ada r0 r1, todo/grace r2, done/ada r3 r4, (empty) r5.
const ids = ["r0", "r1", "r2", "r3", "r4", "r5"];
const roots = buildOutline(groups);
const can = () => true;

describe("leafNodes", () => {
  it("lists the groups that hold records", () => {
    expect(leafNodes(roots).map((n) => n.path)).toEqual(["st:todo/ow:ada", "st:todo/ow:grace", "st:done/ow:ada", "st:"]);
  });
});

describe("planDrop", () => {
  it("moves within a group before or after the row it is dropped on, by the direction of the drag", () => {
    expect(planDrop(ids, roots, "r0", { kind: "row", id: "r1" }, can)).toMatchObject({ afterId: "r1", values: {} });
    expect(planDrop(ids, roots, "r4", { kind: "row", id: "r3" }, can)).toMatchObject({ beforeId: "r3", values: {} });
    expect(planDrop(ids, roots, "r0", { kind: "row", id: "r0" }, can)).toBeNull();
  });

  it("puts a row in another group before the row it is dropped on, with that group's values", () => {
    const plan = planDrop(ids, roots, "r0", { kind: "row", id: "r3" }, can);
    expect(plan).toMatchObject({ beforeId: "r3", values: { st: "done" }, groupLabel: "done" });
    // The owner is "ada" in both: only the level that differs is written.
    expect(Object.keys((plan as { values: object }).values)).toEqual(["st"]);
    expect(planDrop(ids, roots, "r0", { kind: "row", id: "r2" }, can)).toMatchObject({ beforeId: "r2", values: { ow: "grace" } });
  });

  it("clears the field when it is dropped into the empty group", () => {
    expect(planDrop(ids, roots, "r0", { kind: "row", id: "r5" }, can)).toMatchObject({ beforeId: "r5", values: { st: null } });
  });

  it("takes a row dropped on a heading to the start of that group", () => {
    expect(planDrop(ids, roots, "r4", { kind: "group", path: "st:todo/ow:grace" }, can)).toMatchObject({ beforeId: "r2", values: { st: "todo", ow: "grace" } });
    // Onto a heading that has sub-groups: that level's value, landing in its first sub-group.
    const plan = planDrop(ids, roots, "r4", { kind: "group", path: "st:todo" }, can);
    expect(plan).toMatchObject({ beforeId: "r0", values: { st: "todo" } });
    expect((plan as DropPlan).to.map((x) => x.key)).toEqual(["todo", "ada"]);
    // Already first in its group: nothing to do.
    expect(planDrop(ids, roots, "r0", { kind: "group", path: "st:todo/ow:ada" }, can)).toBeNull();
  });

  it("refuses a group whose field cannot be written", () => {
    expect(planDrop(ids, roots, "r0", { kind: "row", id: "r3" }, (f) => f !== "st")).toBe("blocked");
    // Staying in the group needs no write.
    expect(planDrop(ids, roots, "r0", { kind: "row", id: "r1" }, () => false)).toMatchObject({ afterId: "r1" });
  });

  it("plans a plain list with no groups", () => {
    expect(planDrop(["a", "b", "c"], [], "c", { kind: "row", id: "a" }, can)).toMatchObject({ beforeId: "a", values: {} });
  });

  it("ignores a row that is not in the list", () => {
    expect(planDrop(ids, roots, "nope", { kind: "row", id: "r1" }, can)).toBeNull();
    expect(planDrop(ids, roots, "r0", { kind: "row", id: "nope" }, can)).toBeNull();
  });
});

describe("placeIndexes", () => {
  it("gives where the record was and will be", () => {
    expect(placeIndexes(ids, "r0", { afterId: "r1" })).toEqual({ a: 0, b: 1 });
    expect(placeIndexes(ids, "r4", { beforeId: "r3" })).toEqual({ a: 4, b: 3 });
    expect(placeIndexes(ids, "r0", { beforeId: "nope" })).toBeNull();
  });
});

describe("moveBetweenGroups", () => {
  const starts = (list: GroupHeader[]) => list.map((g) => [g.key, g.start, g.count]);

  it("moves a row into another group and shifts everything between", () => {
    const plan = planDrop(ids, roots, "r0", { kind: "row", id: "r3" }, can);
    if (!plan || plan === "blocked") throw new Error("plan");
    const at = placeIndexes(ids, "r0", plan)!;
    // r0 leaves todo/ada for done/ada: [r1 r2 | r0 r3 r4 | r5]
    expect(starts(moveBetweenGroups(groups, at.a, at.b, plan.from, plan.to))).toEqual([
      ["todo", 0, 2],
      ["ada", 0, 1],
      ["grace", 1, 1],
      ["done", 2, 3],
      ["ada", 2, 3],
      ["", 5, 1],
    ]);
  });

  it("moves a row up into an earlier group", () => {
    const plan = planDrop(ids, roots, "r4", { kind: "row", id: "r1" }, can);
    if (!plan || plan === "blocked") throw new Error("plan");
    const at = placeIndexes(ids, "r4", plan)!;
    // r4 joins todo/ada before r1: [r0 r4 r1 | r2 | r3 | r5]
    expect(starts(moveBetweenGroups(groups, at.a, at.b, plan.from, plan.to))).toEqual([
      ["todo", 0, 4],
      ["ada", 0, 3],
      ["grace", 3, 1],
      ["done", 4, 1],
      ["ada", 4, 1],
      ["", 5, 1],
    ]);
  });
});

describe("visibleIds", () => {
  it("leaves out the records of folded groups, but keeps the open one", () => {
    expect(visibleIds(ids, roots, new Set())).toEqual(ids);
    expect(visibleIds(ids, roots, new Set(["st:todo"]))).toEqual(["r3", "r4", "r5"]);
    expect(visibleIds(ids, roots, new Set(["st:todo/ow:ada", "st:done"]))).toEqual(["r2", "r5"]);
    expect(visibleIds(ids, roots, new Set(["st:todo"]), "r1")).toEqual(["r1", "r3", "r4", "r5"]);
  });
});

describe("buildOutline places", () => {
  it("numbers every group among its siblings", () => {
    const tree = buildOutline(groups);
    expect(tree.map((n) => [n.pos, n.size])).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(tree[0]!.children.map((n) => [n.pos, n.size])).toEqual([[1, 2], [2, 2]]);
  });
});

// Sub-items: a record's parent is the first record its parent field links to.
const P = "f_parent";
const node = (id: string, parent?: string | string[]): TableRecord => {
  const parents = parent === undefined ? [] : Array.isArray(parent) ? parent : [parent];
  return makeRecord(parents.length ? { [P]: parents.map((x) => ({ id: x, name: x.toUpperCase() })) } : {}, id);
};
const order = (rows: ReturnType<typeof nestRows>) => rows.map((r) => `${"-".repeat(r.depth)}${r.record.id}`);

describe("parentLinkOf", () => {
  it("is the first linked record, and nothing without a parent field or a link", () => {
    expect(parentLinkOf(node("b", ["a", "z"]), P)).toEqual({ id: "a", name: "A" });
    expect(parentLinkOf(node("b"), P)).toBeNull();
    expect(parentLinkOf(node("b", "a"), null)).toBeNull();
  });
});

describe("nestRows", () => {
  it("leaves the order alone without a parent field", () => {
    const rows = nestRows([node("a"), node("b", "a")], null);
    expect(order(rows)).toEqual(["a", "b"]);
    expect(rows.map((r) => [r.pos, r.size])).toEqual([[1, 2], [2, 2]]);
  });

  it("puts each record right after its parent, deeper, keeping the view's order among siblings", () => {
    const rows = nestRows([node("a"), node("c", "b"), node("b", "a"), node("d"), node("e", "a"), node("f", "e")], P);
    expect(order(rows)).toEqual(["a", "-b", "--c", "-e", "--f", "d"]);
    expect(rows.map((r) => r.children)).toEqual([2, 1, 0, 1, 0, 0]);
    expect(rows.map((r) => r.parentId)).toEqual([null, "a", "b", "a", "e", null]);
    expect(rows.map((r) => [r.pos, r.size])).toEqual([[1, 2], [1, 2], [1, 1], [2, 2], [1, 1], [2, 2]]);
  });

  it("draws a record whose parent is not in the group as a top-level row", () => {
    expect(order(nestRows([node("a", "elsewhere"), node("b", "a")], P))).toEqual(["a", "-b"]);
  });

  it("does not lose the records of a loop, or loop forever on a record that is its own parent", () => {
    expect(order(nestRows([node("a", "b"), node("b", "a"), node("c", "c")], P)).sort()).toEqual(["-b", "a", "c"]);
  });
});

describe("foldRows", () => {
  const rows = nestRows([node("a"), node("b", "a"), node("c", "b"), node("d", "a"), node("e")], P);

  it("hides everything under a folded row, however deep", () => {
    expect(order(foldRows(rows, new Set()))).toEqual(["a", "-b", "--c", "-d", "e"]);
    expect(order(foldRows(rows, new Set(["a"])))).toEqual(["a", "e"]);
    expect(order(foldRows(rows, new Set(["b"])))).toEqual(["a", "-b", "-d", "e"]);
  });

  it("names the folded rows that hide a row", () => {
    expect(foldedAncestors(rows, "c", new Set(["a", "b"]))).toEqual(["a", "b"]);
    expect(foldedAncestors(rows, "c", new Set(["b"]))).toEqual(["b"]);
    expect(foldedAncestors(rows, "e", new Set(["a"]))).toEqual([]);
    expect(foldedAncestors(rows, "zzz", new Set(["a"]))).toEqual([]);
  });
});

describe("indent and outdent", () => {
  const rows = nestRows([node("a"), node("b", "a"), node("c", "b"), node("d", "a"), node("e")], P);

  it("indents under the row above at the same level", () => {
    expect(indentTarget(rows, "e")?.id).toBe("a");
    expect(indentTarget(rows, "d")?.id).toBe("b");
    expect(indentTarget(rows, "c")).toBeNull(); // first of its level under b
    expect(indentTarget(rows, "a")).toBeNull();
    expect(indentTarget(rows, "nope")).toBeNull();
  });

  it("outdents to the parent's own parent", () => {
    expect(outdentValue(rows, "c", P)).toEqual([{ id: "a", name: "A" }]);
    expect(outdentValue(rows, "b", P)).toEqual([]);
    expect(outdentValue(rows, "a", P)).toBeNull();
  });

  it("outdents a row whose parent is in another group by clearing the link", () => {
    expect(outdentValue(nestRows([node("a", "elsewhere")], P), "a", P)).toEqual([]);
  });
});

describe("rowLabel", () => {
  it("says the title, then each shown value with its field, then the description", () => {
    const num = ALL_FIELDS.number!;
    const done = ALL_FIELDS.checkbox!;
    const label = rowLabel("Write docs", [{ field: num, value: 3 }, { field: done, value: true }], "Draft first", DEFAULT_CTX);
    expect(label).toBe(`Write docs, ${num.name}: 3.00, ${done.name}: checked, Draft first`);
    expect(rowLabel("Idea", [], "", DEFAULT_CTX)).toBe("Idea");
  });
});

describe("withTails", () => {
  const r = (id: string) => makeRecord({}, id);
  // Eight records in three groups; only the first four are loaded: A r0 r1, B r2 r3 r4 (runs over), C r5 r6 r7.
  const gs = [h(0, "st", "a", 0, 2), h(0, "st", "b", 2, 3), h(0, "st", "c", 5, 3)];
  const base = [r("r0"), r("r1"), r("r2"), r("r3")];

  it("leaves a fully loaded list as it is", () => {
    const out = withTails(base, [h(0, "st", "a", 0, 2), h(0, "st", "b", 2, 2)], 4, new Map());
    expect(out.records.map((x) => x.id)).toEqual(["r0", "r1", "r2", "r3"]);
    expect([...out.loaded]).toEqual([["st:a", 2], ["st:b", 2]]);
  });

  it("counts what is loaded of a group that runs over the end", () => {
    const out = withTails(base, gs, 8, new Map());
    expect([...out.loaded]).toEqual([["st:a", 2], ["st:b", 2], ["st:c", 0]]);
    expect(out.records).toHaveLength(4);
  });

  it("appends the fetched rows after the loaded ones and moves the groups' starts", () => {
    const out = withTails(base, gs, 8, new Map([["st:b", [r("r4")]], ["st:c", [r("r5"), r("r6")]]]));
    expect(out.records.map((x) => x.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(out.groups.map((g) => [g.key, g.start, g.count])).toEqual([["a", 0, 2], ["b", 2, 3], ["c", 5, 3]]);
    expect([...out.loaded]).toEqual([["st:a", 2], ["st:b", 3], ["st:c", 2]]);
  });

  it("starts a group that lies wholly past the end after the rows fetched before it", () => {
    const out = withTails(base, gs, 8, new Map([["st:c", [r("r5")]]]));
    expect(out.records.map((x) => x.id)).toEqual(["r0", "r1", "r2", "r3", "r5"]);
    expect(out.groups.find((g) => g.key === "c")).toMatchObject({ start: 4, count: 3 });
    expect(out.loaded.get("st:c")).toBe(1);
  });

  it("moves the start of a group that holds sub-groups to its first sub-group's", () => {
    const nested = [h(0, "st", "a", 0, 4), h(1, "ow", "x", 0, 4), h(0, "st", "z", 4, 3), h(1, "ow", "y", 4, 3)];
    const out = withTails(base, nested, 7, new Map([["st:z/ow:y", [r("r4"), r("r5")]]]));
    expect(out.groups.map((g) => [g.key, g.start])).toEqual([["a", 0], ["x", 0], ["z", 4], ["y", 4]]);
    expect(out.loaded.get("st:z/ow:y")).toBe(2);
  });

  it("treats a list without groups as one group of `total` records", () => {
    const out = withTails(base, [], 7, new Map([["", [r("r4"), r("r5")]]]));
    expect(out.records).toHaveLength(6);
    expect(out.loaded.get("")).toBe(6);
    expect(out.groups).toEqual([]);
  });
});
