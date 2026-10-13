import { describe, expect, it } from "vitest";
import type { GroupHeader, TableRecord } from "@/api/types";
import { layoutRows } from "./tableRows";

const rec = (id: string) => ({ id, values: {} }) as unknown as TableRecord;
const header = (depth: number, label: string, start: number, count: number): GroupHeader => ({ depth, field_id: "f", key: label, label, value: label, start, count });
const summary = (rows: ReturnType<typeof layoutRows>) => rows.map((r) => (r.kind === "record" ? r.record.id : `${r.continued ? "…" : ""}${r.header.label}`));

describe("table rows with groups", () => {
  it("is just the records when nothing is grouped", () => {
    expect(summary(layoutRows([rec("a"), rec("b")], 0, []))).toEqual(["a", "b"]);
    expect(summary(layoutRows([], 0, []))).toEqual([]);
  });

  it("puts each header before the first record of its group, outer groups first", () => {
    const groups = [header(0, "Todo", 0, 2), header(1, "Ada", 0, 1), header(1, "Grace", 1, 1), header(0, "Done", 2, 1)];
    expect(summary(layoutRows([rec("a"), rec("b"), rec("c")], 0, groups))).toEqual(["Todo", "Ada", "a", "Grace", "b", "Done", "c"]);
  });

  it("shows only the headers inside a later page, and repeats the group it opens in", () => {
    const groups = [header(0, "Todo", 0, 4), header(1, "Ada", 0, 1), header(1, "Grace", 1, 3), header(0, "Done", 4, 2)];
    // Page 2 = records 2 and 3 of the result: still inside Todo / Grace.
    expect(summary(layoutRows([rec("c"), rec("d")], 2, groups))).toEqual(["…Todo", "…Grace", "c", "d"]);
    // Page 3 = records 4 and 5: Done starts exactly on the page, so nothing is "continued".
    expect(summary(layoutRows([rec("e"), rec("f")], 4, groups))).toEqual(["Done", "e", "f"]);
    // A page opening on the second record of Done repeats it.
    expect(summary(layoutRows([rec("f")], 5, groups))).toEqual(["…Done", "f"]);
  });
});
