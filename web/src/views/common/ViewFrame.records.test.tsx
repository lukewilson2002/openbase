/** What every card or row view gets from `useViewSetup` and `ViewFrame`: adding, discarding, deleting and undoing records. */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewProps } from "../types";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "./viewTestUtils";
import { useRecordSelection } from "./useRecordSelection";
import { useViewRecords } from "./useViewRecords";
import { useViewSetup } from "./useViewSetup";
import { ViewFrame } from "./ViewFrame";

afterEach(() => vi.unstubAllGlobals());

/** The smallest view: a button per record and an Add that goes through `addRecord`. */
function MiniView(props: ViewProps) {
  const setup = useViewSetup(props);
  const records = useViewRecords({ tableId: props.table.id, viewId: props.view.id, configKey: setup.configKey, search: "", timeZone: setup.timeZone, transient: setup.transient });
  const ids = (records.data?.records ?? []).map((r) => r.id);
  const sel = useRecordSelection(ids);
  return (
    <ViewFrame setup={setup} recordIds={ids} layout="bare" onAdd={() => void setup.addRecord()}>
      {(records.data?.records ?? []).map((r) => (
        <button key={r.id} type="button" onClick={(e) => !sel.handleClick(r.id, e) && setup.openRecord(r.id)} aria-pressed={sel.has(r.id)}>
          {r.id}
        </button>
      ))}
      <button type="button" onClick={() => setup.actions.requestDelete(sel.ids, sel.clear)}>
        Delete selected
      </button>
    </ViewFrame>
  );
}

const filtered = viewWithConfig("viw1", "list", { filter: { conjunction: "and", items: [{ field_id: F.status.id, op: "is", value: "s3" }] } });

function setup(role = "editor", records = [rec("r1", {}), rec("r2", {}), rec("r3", {})], routes: Record<string, unknown> = {}) {
  return renderView(MiniView, {
    schema: projectSchema(role, [filtered]),
    viewId: "viw1",
    routes: {
      "POST /api/views/viw1/query": queryHandler({ records }),
      "GET /api/tables/tbl1/records/new1": rec("new1", { [F.status.id]: "s3" }),
      "GET /api/records/new1/comments": [],
      "GET /api/records/new1/history": [],
      ...routes,
    } as never,
  });
}

describe("record views", () => {
  it("adds a record that starts as the filter says, and throws it away when its panel closes untouched", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", undefined, { "POST /api/tables/tbl1/records": { records: [rec("new1", { [F.status.id]: "s3" })] }, "POST /api/tables/tbl1/records/new1/discard": { discarded: true } });
    await screen.findByRole("button", { name: "r1" });
    await user.click(screen.getAllByRole("button", { name: "Add record" })[0]!);
    await screen.findByRole("dialog");
    expect((api.callsTo("POST /api/tables/tbl1/records")[0]!.body as { records: { values: unknown }[] }).records[0]!.values).toEqual({ [F.status.id]: "s3" });
    // The first Escape leaves the title being edited, the second closes the panel.
    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/new1/discard")).toHaveLength(1));
  });

  it("keeps a record added and then changed in its panel", async () => {
    const user = userEvent.setup();
    let current = rec("new1", { [F.status.id]: "s3" });
    const { api } = setup("editor", undefined, {
      "POST /api/tables/tbl1/records": { records: [current] },
      "GET /api/tables/tbl1/records/new1": () => current,
      "PATCH /api/tables/tbl1/records": () => {
        current = rec("new1", { [F.status.id]: "s3", [F.name.id]: "Typed" });
        return { records: [current] };
      },
      "DELETE /api/tables/tbl1/records": null,
    });
    await screen.findByRole("button", { name: "r1" });
    await user.click(screen.getAllByRole("button", { name: "Add record" })[0]!);
    await screen.findByRole("dialog");
    await user.keyboard("Typed{Enter}");
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 150));
    expect(api.callsTo("DELETE /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("asks before deleting several selected records, and Ctrl+Z brings them back", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", undefined, { "DELETE /api/tables/tbl1/records": null, "POST /api/tables/tbl1/records/restore": { records: [] } });
    await screen.findByRole("button", { name: "r1" });
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("button", { name: "r1" }));
    await user.click(screen.getByRole("button", { name: "r2" }));
    await user.keyboard("{/Control}");
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete 2 records?");
    // An editor restores only the records they deleted themselves, and the text says so.
    expect(dialog).toHaveTextContent("editors can restore the records they deleted themselves");
    expect(dialog).toHaveTextContent("Press Undo right after");
    await user.click(screen.getByRole("button", { name: "Delete 2 records" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r1", "r2"] }));
    await screen.findByText("2 records deleted");
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/restore")[0]!.body).toEqual({ ids: ["r1", "r2"] }));
  });
});
