import { describe, expect, it } from "vitest";
import type { BaseSchema, WorkspaceSummary } from "@/api/types";
import { makeSchema, makeView } from "@/test/utils";
import { applyOrder, moveId, reorderProjectsIn, reorderTablesIn, reorderTablesInWorkspaces, reorderViewsIn, reorderWorkspacesIn } from "./useReorder";

const item = (id: string) => ({ id });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("applyOrder", () => {
  it("puts the listed items in the given order", () => {
    expect(ids(applyOrder(["a", "b", "c"].map(item), ["c", "a", "b"], (x) => x.id))).toEqual(["c", "a", "b"]);
  });

  it("gives the listed items the places they held and leaves the others where they are", () => {
    // b and d are listed: they swap, a, c and e stay.
    expect(ids(applyOrder(["a", "b", "c", "d", "e"].map(item), ["d", "b"], (x) => x.id))).toEqual(["a", "d", "c", "b", "e"]);
  });

  it("ignores ids that match nothing and repeated ids", () => {
    expect(ids(applyOrder(["a", "b", "c"].map(item), ["c", "zzz", "c", "a"], (x) => x.id))).toEqual(["c", "b", "a"]);
  });

  it("changes nothing for no ids, and never changes its input", () => {
    const items = ["a", "b"].map(item);
    expect(applyOrder(items, [], (x) => x.id)).toEqual(items);
    applyOrder(items, ["b", "a"], (x) => x.id);
    expect(ids(items)).toEqual(["a", "b"]);
  });
});

describe("moveId", () => {
  it("moves an id one place up or down", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("is null at the ends and for an id that is not there", () => {
    expect(moveId(["a", "b"], "a", -1)).toBeNull();
    expect(moveId(["a", "b"], "b", 1)).toBeNull();
    expect(moveId(["a", "b"], "x", 1)).toBeNull();
  });
});

const base = (id: string, workspace_id: string, tables: string[] = []) => ({ id, workspace_id, name: id, color: "blue", icon: null, role: "owner", people: [], tables: tables.map((t) => ({ id: t, name: t })) });
const workspace = (id: string, bases: ReturnType<typeof base>[]): WorkspaceSummary => ({ id, name: id, color: "green", role: "owner", bases, member_count: 1, pending_invite_count: 0 });

describe("cache transforms", () => {
  const list = [workspace("w1", [base("a1", "w1", ["t1", "t2"]), base("a2", "w1"), base("a3", "w1")]), workspace("w2", [base("a4", "w2", ["t9", "t8"])])];

  it("orders workspaces, and passes an unloaded list through", () => {
    expect(ids(reorderWorkspacesIn(list, ["w2", "w1"])!)).toEqual(["w2", "w1"]);
    expect(reorderWorkspacesIn(undefined, ["w2", "w1"])).toBeUndefined();
  });

  it("orders the projects of one workspace only", () => {
    const out = reorderProjectsIn(list, "w1", ["a3", "a1", "a2"])!;
    expect(ids(out[0]!.bases)).toEqual(["a3", "a1", "a2"]);
    expect(out[1]).toBe(list[1]);
    expect(ids(list[0]!.bases)).toEqual(["a1", "a2", "a3"]);
  });

  it("orders the table summaries of one project only", () => {
    const out = reorderTablesInWorkspaces(list, "a1", ["t2", "t1"])!;
    expect(ids(out[0]!.bases[0]!.tables)).toEqual(["t2", "t1"]);
    expect(out[1]).toBe(list[1]);
    expect(ids(reorderTablesInWorkspaces(list, "a4", ["t8", "t9"])![1]!.bases[0]!.tables)).toEqual(["t8", "t9"]);
  });

  describe("a project's schema", () => {
    const schema: BaseSchema = makeSchema("owner");
    schema.tables[0]!.views = [
      makeView({ id: "d", is_default: true }),
      makeView({ id: "s1" }),
      makeView({ id: "p1", personal: true }),
      makeView({ id: "s2" }),
      makeView({ id: "p2", personal: true }),
      makeView({ id: "s3" }),
    ];

    it("orders its tables", () => {
      expect(ids(reorderTablesIn(schema, ["tbl2", "tbl1"])!.tables)).toEqual(["tbl2", "tbl1"]);
      expect(reorderTablesIn(undefined, ["tbl2"])).toBeUndefined();
    });

    it("orders the shared views among their own places, leaving the personal ones and the default grid", () => {
      const out = reorderViewsIn(schema, "tbl1", ["s3", "s1", "s2"])!;
      expect(ids(out.tables[0]!.views)).toEqual(["d", "s3", "p1", "s1", "p2", "s2"]);
      // The other table is the same object.
      expect(out.tables[1]).toBe(schema.tables[1]);
    });

    it("orders the personal views among theirs", () => {
      expect(ids(reorderViewsIn(schema, "tbl1", ["p2", "p1"])!.tables[0]!.views)).toEqual(["d", "s1", "p2", "s2", "p1", "s3"]);
    });
  });
});
