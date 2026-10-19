import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers, createQueryClient } from "@/providers";
import { CHOICES, PEOPLE, field, makeRecord, makeTable } from "@/test/fields";
import { makeSchema, makeView, mockApi } from "@/test/utils";
import { formatTrail, parseTrail } from "@/views/common/RecordPanel";
import { ExpandedRecord, type ExpandedRecordProps } from "../ExpandedRecord";
import { EditorEnvProvider } from "../editors/env";
import { LinkEditor } from "../editors/LinkEditor";

// Tasks (tbl1): Name, Requires -> Tasks of tbl2 ("Setup").
const name = field("single_line_text", {}, { id: "fld_name", name: "Name" });
const requires = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_req_by", single: false }, { id: "fld_requires", name: "Requires" });
const tasks = makeTable([name, requires]);
// Setup (tbl2): Title, Status, Notes, Due (hidden in its grid), Owner text; its grid puts Notes first.
const title = { ...field("single_line_text", {}, { id: "fld_title", name: "Title" }), table_id: "tbl2" };
const status = { ...field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" }), table_id: "tbl2" };
const notes = { ...field("long_text", { rich: false }, { id: "fld_notes", name: "Notes" }), table_id: "tbl2" };
const due = { ...field("date", { include_time: false, date_format: "iso", time_format: "h24" } as never, { id: "fld_due", name: "Due" }), table_id: "tbl2" };
const extra = { ...field("single_line_text", {}, { id: "fld_extra", name: "Extra" }), table_id: "tbl2" };
const grid2 = makeView({ id: "viw2" });
const setupTable = makeTable([title, status, notes, due, extra], {
  id: "tbl2",
  name: "Setup",
  views: [{ ...grid2, table_id: "tbl2", config: { ...grid2.config, field_order: ["fld_title", "fld_notes", "fld_status"], hidden_fields: ["fld_due"] } }],
});
const schema = { ...makeSchema("owner"), tables: [tasks, setupTable] };
const task = makeRecord({ fld_name: "Build the website", fld_requires: [{ id: "recD", name: "Buy the domain" }] }, "rec1");
const domain = { ...makeRecord({ fld_title: "Buy the domain", fld_status: "chs3", fld_notes: "Registered at Porkbun", fld_due: "2026-10-01", fld_extra: "Renews yearly" }, "recD"), table_id: "tbl2" };

afterEach(() => vi.useRealTimers());

function setup(over: Partial<ExpandedRecordProps> = {}) {
  const api = mockApi({
    "GET /api/tables/tbl1/records/rec1": task,
    "GET /api/records/rec1/comments": [],
    "GET /api/records/rec1/history": [],
    "POST /api/tables/tbl2/records/get": (call: { body: unknown }) => ({ records: (call.body as { ids: string[] }).ids.includes("recD") ? [domain] : [] }),
    "GET /api/tables/tbl2/records/recD": domain,
  } as never);
  const props: ExpandedRecordProps = {
    schema,
    table: tasks,
    role: "owner",
    recordId: "rec1",
    config: tasks.views[0]!.config,
    prevId: null,
    nextId: null,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    emails: new Map(PEOPLE.map((p) => [p.id, p.email])),
    timeZone: "UTC",
    currentUserId: "usr1",
    collaborators: PEOPLE,
    onOpenLinked: vi.fn(),
    ...over,
  };
  render(
    <Providers client={createQueryClient()}>
      <ExpandedRecord {...props} />
    </Providers>,
  );
  return { api, props };
}

describe("linked records in the record panel", () => {
  it("shows each linked record as a card with the first filled fields of its table's grid, and opens it", async () => {
    const { api, props } = setup();
    const card = await screen.findByRole("button", { name: "Open Buy the domain" });
    // Its grid's order (Notes before Status), Due hidden there, three fields at most.
    await waitFor(() => expect(within(card).getAllByRole("term").map((t) => t.textContent)).toEqual(["Notes", "Status", "Extra"]));
    expect(card).toHaveTextContent("Registered at Porkbun");
    expect(api.calls.find((c) => c.path === "/api/tables/tbl2/records/get")?.body).toEqual({ ids: ["recD"] });
    await userEvent.click(card);
    expect(props.onOpenLinked).toHaveBeenCalledWith("tbl2", "recD");
    // Opening a card is not an edit of the field.
    expect(screen.queryByRole("combobox", { name: "Search Requires" })).toBeNull();
  });

  it("shows the whole linked record when a finger rests on its card, and the press does not open it", async () => {
    const { props } = setup();
    const card = await screen.findByRole("button", { name: "Open Buy the domain" });
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    const peek = await waitFor(() => {
      const el = document.querySelector("[data-record-peek]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // Every filled field of the grid's layout (Due is hidden there), with the table's name.
    expect(within(peek).getAllByRole("term").map((t) => t.textContent)).toEqual(["Notes", "Status", "Extra"]);
    expect(peek).toHaveTextContent("Setup");
    fireEvent.pointerUp(card, { pointerType: "touch" });
    fireEvent.click(card);
    expect(props.onOpenLinked).not.toHaveBeenCalled();
    await userEvent.click(within(peek).getByRole("button", { name: /Open/ }));
    expect(props.onOpenLinked).toHaveBeenCalledWith("tbl2", "recD");
  });

  it("goes back to the record it came from", async () => {
    const onBack = vi.fn();
    setup({ onBack, backLabel: "Build the website" });
    await userEvent.click(await screen.findByRole("button", { name: "Back to Build the website" }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Previous record/ })).toBeNull();
  });
});

describe("the linked trail", () => {
  it("round-trips, and drops steps whose table is gone", () => {
    const raw = formatTrail([
      { tableId: "tbl2", recordId: "recD" },
      { tableId: "tblGone", recordId: "recX" },
      { tableId: "tbl1", recordId: "rec9" },
    ]);
    expect(raw).toBe("tbl2.recD,tblGone.recX,tbl1.rec9");
    expect(parseTrail(raw, schema).map((s) => `${s.table.id}.${s.recordId}`)).toEqual(["tbl2.recD", "tbl1.rec9"]);
    expect(parseTrail(null, schema)).toEqual([]);
  });
});

describe("the link picker", () => {
  it("shows a few fields under each result and searches them too", async () => {
    const api = mockApi({
      "GET /api/tables/tbl2/records/lookup": { records: [{ id: "recD", name: "Buy the domain" }] },
      "POST /api/tables/tbl2/records/get": { records: [domain] },
    } as never);
    const env = { baseId: "app1", tableId: "tbl1", collaborators: PEOPLE, timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: "usr1", schema };
    render(
      <Providers client={createQueryClient()}>
        <EditorEnvProvider value={env}>
          <LinkEditor field={requires} value={[]} variant="form" onChange={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()} />
        </EditorEnvProvider>
      </Providers>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Requires/ }));
    const option = await screen.findByRole("option");
    await waitFor(() => expect(option).toHaveTextContent("Registered at Porkbun"));
    expect(option).toHaveTextContent("Buy the domain");
    const lookup = api.calls.find((c) => c.path === "/api/tables/tbl2/records/lookup")!;
    expect(lookup.query.get("fields")).toBe("fld_notes,fld_status,fld_extra");
  });
});
