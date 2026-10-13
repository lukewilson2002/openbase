import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import { apiError, mockApi, renderWithProviders, type Handler } from "@/test/utils";
import { ImportCsvDialog } from "./ImportCsvDialog";
import { NewTableFromCsvDialog } from "./NewTableFromCsvDialog";

afterEach(() => vi.unstubAllGlobals());

const name = field("single_line_text", {}, { id: "f_name", name: "Name" });
const qty = field("number", { precision: 0, allow_negative: true }, { id: "f_qty", name: "Qty" });
const status = field("single_select", { choices: [{ id: "c1", name: "Todo", color: "gray" }] }, { id: "f_status", name: "Status" });
const owner = field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" });
const total = field("formula", { expression: "1", result_type: "number" }, { id: "f_total", name: "Total" });
const table = makeTable([name, qty, status, owner, total, ALL_FIELDS.attachment!]);

const csv = (content: string, filename = "people.csv") => new File([content], filename, { type: "text/csv" });
const CSV = "Name,Qty,Notes\nAnn,1,hello\nBob,2,world\n";

function importer(routes: Record<string, Handler> = {}) {
  const api = mockApi(routes);
  renderWithProviders(<ImportCsvDialog open onOpenChange={() => {}} baseId="app1" table={table} />);
  return api;
}

async function choose(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(await screen.findByLabelText("CSV file"), file);
}

describe("importing a CSV into a table", () => {
  it("shows the first rows and matches columns to fields by name", async () => {
    const user = userEvent.setup();
    importer();
    await choose(user, csv(CSV));
    const mapping = await screen.findByRole("region", { name: "Column mapping" });
    expect(within(mapping).getByLabelText("Field for Name")).toHaveValue("f_name");
    expect(within(mapping).getByLabelText("Field for Qty")).toHaveValue("f_qty");
    expect(within(mapping).getByLabelText("Field for Notes")).toHaveValue(""); // no such field: skipped
    expect(within(mapping).getByText("Ann")).toBeInTheDocument();
    expect(within(mapping).getByText("world")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 2 columns" })).toBeEnabled();
    // Fields the server cannot import into are not offered, and the dialog says why.
    const options = within(within(mapping).getByLabelText("Field for Name")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Skip this column", "Name", "Qty", "Status"]);
    expect(screen.getByText(/Owner, Total, attachment cannot be imported/)).toBeInTheDocument();
  });

  it("sends the file, the header flag and a mapping keyed by the column names", async () => {
    const user = userEvent.setup();
    const api = importer({ "POST /api/tables/tbl1/import": { created: 2, table_id: "tbl1", fields: [] } });
    await choose(user, csv(CSV));
    await screen.findByRole("region", { name: "Column mapping" });
    await user.selectOptions(screen.getByLabelText("Field for Notes"), "f_status");
    await user.click(screen.getByRole("button", { name: "Import 3 columns" }));
    expect(await screen.findByText("Imported 2 records")).toBeInTheDocument();
    const call = api.callsTo("POST /api/tables/tbl1/import")[0]!;
    const form = call.body as FormData;
    expect((form.get("file") as File).name).toBe("people.csv");
    expect(form.get("has_header")).toBe("true");
    expect(JSON.parse(String(form.get("mapping")))).toEqual({ Name: "f_name", Qty: "f_qty", Notes: "f_status" });
  });

  it("keys the mapping by column number when the file has no header row", async () => {
    const user = userEvent.setup();
    const api = importer({ "POST /api/tables/tbl1/import": { created: 3, table_id: "tbl1", fields: [] } });
    await choose(user, csv(CSV));
    await screen.findByRole("region", { name: "Column mapping" });
    await user.click(screen.getByRole("checkbox", { name: /first row holds the column names/ }));
    const mapping = screen.getByRole("region", { name: "Column mapping" });
    // The header row is data now: it is shown as a row, and nothing matches by name any more.
    expect(within(mapping).getByRole("cell", { name: "Qty" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    await user.selectOptions(within(mapping).getByLabelText("Field for column 1"), "f_name");
    await user.click(screen.getByRole("button", { name: "Import 1 column" }));
    await screen.findByText("Imported 3 records");
    const form = api.callsTo("POST /api/tables/tbl1/import")[0]!.body as FormData;
    expect(form.get("has_header")).toBe("false");
    expect(JSON.parse(String(form.get("mapping")))).toEqual({ "0": "f_name", "1": null, "2": null });
  });

  it("makes the keys the same as the server's for repeated and empty column names", async () => {
    const user = userEvent.setup();
    const api = importer({ "POST /api/tables/tbl1/import": { created: 1, table_id: "tbl1", fields: [] } });
    await choose(user, csv("Name,name,,Qty\nA,B,C,1\n"));
    await screen.findByRole("region", { name: "Column mapping" });
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    await screen.findByText("Imported 1 record");
    const form = api.callsTo("POST /api/tables/tbl1/import")[0]!.body as FormData;
    expect(Object.keys(JSON.parse(String(form.get("mapping"))))).toEqual(["Name", "name 2", "Column 3", "Qty"]);
  });

  it("will not map two columns to one field", async () => {
    const user = userEvent.setup();
    importer();
    await choose(user, csv(CSV));
    await screen.findByRole("region", { name: "Column mapping" });
    const notes = screen.getByLabelText("Field for Notes");
    // Taken fields are disabled in the other columns' lists.
    expect(within(notes).getByRole("option", { name: "Name" })).toBeDisabled();
    expect(within(notes).getByRole("option", { name: "Status" })).toBeEnabled();
  });

  it("lists the rows the server refused and says nothing was imported", async () => {
    const user = userEvent.setup();
    importer({
      "POST /api/tables/tbl1/import": {
        status: 422,
        json: { error: { code: "import_failed", message: "2 row(s) could not be imported; nothing was imported", rows: [{ row: 3, message: '"abc" is not a number' }, { row: 7, message: "Negative numbers are not allowed" }], truncated: false } },
      },
    });
    await choose(user, csv(CSV));
    await screen.findByRole("region", { name: "Column mapping" });
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    const alert = await screen.findByText("Nothing was imported.");
    const list = within(alert.closest("[role=alert]") as HTMLElement).getByRole("list", { name: "Problem rows" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(['Row 3"abc" is not a number', "Row 7Negative numbers are not allowed"]);
    // The file and mapping are kept so it can be fixed and retried.
    expect(screen.getByRole("button", { name: /^Import/ })).toBeEnabled();
    expect(screen.queryByText(/Imported \d+ record/)).not.toBeInTheDocument();
  });

  it("says when only some of the problems are listed", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 50 }, (_, i) => ({ row: i + 2, message: "bad" }));
    importer({ "POST /api/tables/tbl1/import": { status: 422, json: { error: { code: "import_failed", message: "at least 50", rows, truncated: true } } } });
    await choose(user, csv(CSV));
    await screen.findByRole("region", { name: "Column mapping" });
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    expect(await screen.findByText(/At least 50 rows could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/Only the first problems are listed/)).toBeInTheDocument();
  });

  it("shows other refusals, such as a file that is too large for the server", async () => {
    const user = userEvent.setup();
    importer({ "POST /api/tables/tbl1/import": apiError(413, "payload_too_large", "the CSV file is larger than 20 MB") });
    await choose(user, csv(CSV));
    await screen.findByRole("region", { name: "Column mapping" });
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    expect(await screen.findByText("the CSV file is larger than 20 MB")).toBeInTheDocument();
  });

  it("disables everything while the import runs", async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    importer({ "POST /api/tables/tbl1/import": () => new Promise((r) => (release = r)) });
    await choose(user, csv(CSV));
    await screen.findByRole("region", { name: "Column mapping" });
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    expect(await screen.findByText(/Importing…/)).toBeInTheDocument();
    expect(screen.getByLabelText("Field for Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    release({ created: 2, table_id: "tbl1", fields: [] });
    expect(await screen.findByText("Imported 2 records")).toBeInTheDocument();
  });

  it("refuses a file over 20 MB before sending it", async () => {
    const user = userEvent.setup();
    const api = importer();
    const big = csv("a,b\n1,2\n");
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    await choose(user, big);
    expect(await screen.findByText(/limit is 20 MB/)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Column mapping" })).not.toBeInTheDocument();
  });
});

describe("a new table from a CSV", () => {
  function creator(routes: Record<string, Handler> = {}) {
    const api = mockApi({ "GET /api/bases/app1": { id: "app1", tables: [] }, ...routes });
    renderWithProviders(<NewTableFromCsvDialog open onOpenChange={() => {}} baseId="app1" />);
    return api;
  }

  it("suggests the file name, previews the rows and creates the table", async () => {
    const user = userEvent.setup();
    const api = creator({ "POST /api/bases/app1/import": { status: 200, json: { table_id: "tbl9", created: 2, fields: [{ id: "f1", name: "Name", type: "single_line_text" }, { id: "f2", name: "Qty", type: "number" }] } } });
    await choose(user, csv(CSV, "People 2026.csv"));
    expect(await screen.findByLabelText("Table name")).toHaveValue("People 2026");
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(within(preview).getByText("Ann")).toBeInTheDocument();
    expect(within(preview).getByText("primary field")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create table" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/import")).toHaveLength(1));
    const form = api.callsTo("POST /api/bases/app1/import")[0]!.body as FormData;
    expect((form.get("file") as File).name).toBe("People 2026.csv");
    expect(form.get("has_header")).toBe("true");
    // The suggestion is not sent: the server names it and keeps the name unique.
    expect(form.has("name")).toBe(false);
  });

  it("sends the name the person typed", async () => {
    const user = userEvent.setup();
    const api = creator({ "POST /api/bases/app1/import": { table_id: "tbl9", created: 2, fields: [] } });
    await choose(user, csv(CSV));
    const nameBox = await screen.findByLabelText("Table name");
    await user.clear(nameBox);
    await user.type(nameBox, "Customers");
    await user.click(screen.getByRole("button", { name: "Create table" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/import")).toHaveLength(1));
    expect((api.callsTo("POST /api/bases/app1/import")[0]!.body as FormData).get("name")).toBe("Customers");
  });

  it("shows why a file was refused", async () => {
    const user = userEvent.setup();
    creator({ "POST /api/bases/app1/import": { status: 422, json: { error: { code: "import_failed", message: "1 row(s) could not be imported", rows: [{ row: 4, message: "invalid value" }], truncated: false } } } });
    await choose(user, csv(CSV));
    await screen.findByLabelText("Table name");
    await user.click(screen.getByRole("button", { name: "Create table" }));
    expect(await screen.findByText("Nothing was imported.")).toBeInTheDocument();
    expect(screen.getByText("invalid value")).toBeInTheDocument();
  });
});
