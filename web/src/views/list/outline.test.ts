import { describe, expect, it } from "vitest";
import type { GroupHeader } from "@/api/types";
import { allPaths, buildOutline, flattenOutline, groupDefaults } from "./outline";

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
