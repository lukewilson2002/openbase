import { describe, expect, it } from "vitest";
import { createQueryClient } from "@/providers";
import { makeSchema, makeWorkspace } from "@/test/utils";
import { keys } from "./keys";
import type { WorkspaceSummary } from "./types";

const base = { id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green", role: "owner", people: [], tables: [{ id: "tbl1", name: "Tasks", icon: null }] };

describe("syncBaseTablesIntoWorkspaces", () => {
  it("puts a freshly loaded schema's tables on the base in the workspace list", async () => {
    const qc = createQueryClient();
    const list = [makeWorkspace("owner", [base]), { ...makeWorkspace("owner"), id: "wsp2" }];
    qc.setQueryData(keys.workspaces, list);
    const schema = makeSchema("owner");
    await qc.fetchQuery({ queryKey: keys.base("app1"), queryFn: () => schema });
    const after = qc.getQueryData<WorkspaceSummary[]>(keys.workspaces)!;
    expect(after[0]!.bases[0]!.tables).toEqual(schema.tables.map((t) => ({ id: t.id, name: t.name, icon: t.icon ?? null })));
    // Other workspaces are untouched.
    expect(after[1]).toBe(list[1]);
  });

  it("leaves the list alone when nothing changed, and ignores other base queries", async () => {
    const qc = createQueryClient();
    const schema = makeSchema("owner");
    const list = [makeWorkspace("owner", [{ ...base, tables: schema.tables.map((t) => ({ id: t.id, name: t.name, icon: t.icon ?? null })) }])];
    qc.setQueryData(keys.workspaces, list);
    await qc.fetchQuery({ queryKey: keys.base("app1"), queryFn: () => schema });
    await qc.fetchQuery({ queryKey: keys.baseMembers("app1"), queryFn: () => [] });
    expect(qc.getQueryData(keys.workspaces)).toBe(list);
  });
});
