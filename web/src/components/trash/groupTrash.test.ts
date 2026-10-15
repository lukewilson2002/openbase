import { describe, expect, it } from "vitest";
import type { TrashItem } from "@/api/types";
import { groupTrash, trashItemName } from "./groupTrash";

const item = (kind: string, id: string, deleted_at: number, name = id): TrashItem => ({
  kind,
  id,
  name,
  table_id: null,
  deleted_at,
  workspace_id: "wsp1",
  workspace_name: "Acme",
  workspace_color: "green",
  expires_at: deleted_at + 30 * 86_400_000,
});

describe("groupTrash", () => {
  it("orders kinds tables, fields, views, records and items newest first", () => {
    const groups = groupTrash([item("record", "r1", 10), item("table", "t1", 5), item("record", "r2", 30), item("view", "v1", 1), item("field", "f1", 2)]);
    expect(groups.map((g) => g.kind)).toEqual(["table", "field", "view", "record"]);
    expect(groups[3]!.items.map((i) => i.id)).toEqual(["r2", "r1"]);
  });

  it("omits empty kinds and kinds that do not belong to a base trash", () => {
    expect(groupTrash([item("base", "b1", 1), item("workspace", "w1", 1)])).toEqual([]);
    expect(groupTrash([item("view", "v1", 1)]).map((g) => g.kind)).toEqual(["view"]);
  });

  it("names unnamed items", () => {
    expect(trashItemName(item("record", "r1", 1, "  "))).toBe("Untitled record");
    expect(trashItemName(item("view", "v1", 1, ""))).toBe("Unnamed view");
    expect(trashItemName(item("table", "t1", 1, "Tasks"))).toBe("Tasks");
  });
});
