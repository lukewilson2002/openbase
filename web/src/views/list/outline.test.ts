import { describe, expect, it } from "vitest";
import type { GroupHeader } from "@/api/types";
import { allPaths, buildOutline, flattenOutline, groupDefaults, leafNodes, moveBetweenGroups, placeIndexes, planDrop, visibleIds, type DropPlan } from "./outline";

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
