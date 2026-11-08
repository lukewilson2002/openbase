/** What every card or row view gets from `useViewSetup` and `ViewFrame`: adding, deleting and undoing records. */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewProps } from "../types";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "./viewTestUtils";
import { useRecordSelection } from "./useRecordSelection";
import { useViewRecords } from "./useViewRecords";
import { isNewRecord } from "@/record/newRecords";
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
      ...routes,
    } as never,
  });
}

describe("record views", () => {
  it("adds a record that starts as the filter says, and opens its page, where it is taken back if left empty", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", undefined, { "POST /api/tables/tbl1/records": { records: [rec("new1", { [F.status.id]: "s3" })] } });
    await screen.findByRole("button", { name: "r1" });
    await user.click(screen.getAllByRole("button", { name: "Add record" })[0]!);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viw1/r/new1"));
    expect((api.callsTo("POST /api/tables/tbl1/records")[0]!.body as { records: { values: unknown }[] }).records[0]!.values).toEqual({ [F.status.id]: "s3" });
    // What it was made with is kept for the page, which looks at it again once it has been left.
    expect(isNewRecord("new1")).toBe(true);
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
