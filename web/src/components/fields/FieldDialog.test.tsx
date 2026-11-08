import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Field } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { COLORS } from "@/lib/colors";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import { makeSchema, mockApi, stubDesktop, stubPhone } from "@/test/utils";
import { FieldDialog, type FieldDialogState } from "./FieldDialog";

const link = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_link", name: "Owner" });
const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const table = makeTable([name, link]);
const people = makeTable([field("text", { multiline: false }, { id: "fld_p", name: "Person" }), field("email", {}, { id: "fld_pe", name: "Email" })], { id: "tbl2", name: "People" });
const schema = { ...makeSchema("owner"), tables: [table, people] };

function setup(state: FieldDialogState = { mode: "create" }) {
  const api = mockApi({
    "POST /api/tables/tbl1/fields": (call) => ({ status: 201, json: { id: "fld_new", table_id: "tbl1", ...(call.body as object) } }),
    "GET /api/views/viw1/aggregations": { values: { fld_n: 7 } },
    "PATCH /api/fields/fld_n": (call) => ({ id: "fld_n", table_id: "tbl1", name: "Qty", ...(call.body as object) }),
  });
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  render(
    <Providers client={createQueryClient()}>
      <FieldDialog state={state} schema={schema} table={table} onOpenChange={onOpenChange} onSaved={onSaved} />
    </Providers>,
  );
  return { api, onOpenChange, onSaved };
}

// A desktop by default, where the type list opens in the dialog; the phone tests say so.
beforeEach(() => stubDesktop());

const body = (api: ReturnType<typeof mockApi>) => api.callsTo("POST /api/tables/tbl1/fields")[0]!.body as Record<string, unknown>;

async function openTypePicker() {
  const toggle = screen.queryByRole("listbox", { name: "Property types" });
  if (!toggle) await userEvent.click(screen.getByRole("button", { name: /^Type/ }));
}

async function pick(label: string) {
  await openTypePicker();
  const list = screen.getByRole("listbox", { name: "Property types" });
  await userEvent.click(within(list).getByRole("option", { name: new RegExp(`^${label}`) }));
}

describe("FieldDialog: create", () => {
  it("starts as the asked-for type (\"Add a date field\" from a calendar)", async () => {
    const { api, onSaved } = setup({ mode: "create", type: "date" });
    // The type is chosen already, so the picker stays closed.
    expect(screen.queryByRole("listbox", { name: "Property types" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Due");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body(api)).toMatchObject({ name: "Due", type: "date" });
  });

  it("creates a one-line text field by default", async () => {
    const { api, onSaved, onOpenChange } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Title");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body(api)).toEqual({ name: "Title", description: null, type: "text", options: { multiline: false } });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("creates multiline text when Multiline is ticked", async () => {
    const { api, onSaved } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Address");
    await userEvent.click(screen.getByRole("checkbox", { name: /Multiline/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body(api)).toEqual({ name: "Address", description: null, type: "text", options: { multiline: true } });
  });

  it("tells plain text from Markdown rich text in the type picker", async () => {
    setup();
    await openTypePicker();
    expect(screen.getByRole("option", { name: /^Text/ })).toHaveTextContent("Names, titles and codes");
    expect(screen.getByRole("option", { name: /^Rich text/ })).toHaveTextContent("Markdown: text formatting, tables, lists, images and more");
  });

  it("validates before sending", async () => {
    const { api } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    expect(await screen.findByText("Give the property a name.")).toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(0);
    await userEvent.type(screen.getByLabelText("Name"), "Name");
    expect(screen.getByText(/already has that name/)).toBeInTheDocument();
  });

  it("number options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Qty");
    await pick("Number");
    await userEvent.selectOptions(screen.getByLabelText("Precision"), "3");
    await userEvent.click(screen.getByRole("checkbox", { name: "Allow negative numbers" }));
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "number", options: { precision: 3, allow_negative: false } });
  });

  it("currency options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Price");
    await pick("Currency");
    await userEvent.click(screen.getByRole("button", { name: "Use €" }));
    await userEvent.selectOptions(screen.getByLabelText("Precision"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "currency", options: { symbol: "€", precision: 0, allow_negative: true } });
  });

  it("single select choices: add, rename, reorder, delete", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Stage");
    await pick("Single select");
    await userEvent.click(screen.getByRole("button", { name: "Add option" }));
    await userEvent.keyboard("Alpha{Enter}Beta{Enter}Gamma");
    expect(screen.getAllByLabelText(/Name of option/)).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Move Gamma up" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    const choices = ((body(api).options as { choices: { name: string; color: string; id: string }[] }).choices);
    expect(choices.map((c) => c.name)).toEqual(["Gamma", "Beta"]);
    expect(choices.every((c) => c.id === "" && c.color)).toBe(true);
  });

  it("rejects duplicate option names", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Stage");
    await pick("Multiple select");
    await userEvent.click(screen.getByRole("button", { name: "Add option" }));
    await userEvent.keyboard("A{Enter}a");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    expect(await screen.findByText("Option names must be unique.")).toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(0);
  });

  it("date options including time and a fixed zone", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Starts");
    await pick("Date");
    await userEvent.selectOptions(screen.getByLabelText("Date format"), "iso");
    await userEvent.click(screen.getByRole("checkbox", { name: "Include a time of day" }));
    await userEvent.selectOptions(screen.getByLabelText("Time format"), "h24");
    await userEvent.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "date", options: { include_time: true, date_format: "iso", time_format: "h24", timezone: "America/New_York" } });
  });

  it("link options and inverse name", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Team");
    await pick("Link to another record");
    expect(screen.getByLabelText("Collection to link to")).toHaveTextContent("People");
    await userEvent.click(screen.getByRole("checkbox", { name: "Allow linking to only one record" }));
    await userEvent.type(screen.getByLabelText(/Name of the property created in the linked collection/), "Tasks here");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "link", inverse_name: "Tasks here", options: { linked_table_id: "tbl2", single: true, inverse_field_id: "" } });
  });

  it("user options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Reviewers");
    await pick("User");
    await userEvent.click(screen.getByRole("checkbox", { name: "Allow adding multiple users" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Notify people when they are added" }));
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "user", options: { multiple: true, notify: true } });
  });

  it("rating options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Stars");
    await pick("Rating");
    await userEvent.selectOptions(screen.getByLabelText("Maximum rating"), "10");
    await userEvent.selectOptions(screen.getByLabelText("Icon"), "heart");
    await userEvent.click(screen.getByRole("radio", { name: "Red" }));
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "rating", options: { max: 10, icon: "heart", color: "red" } });
  });

  it("formula: autocomplete after { and the payload; the live check being absent does not block saving", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Shout");
    await pick("Formula");
    const box = screen.getByRole("combobox", { name: "Formula" });
    await userEvent.type(box, "UPPER({{Na");
    const list = await screen.findByRole("listbox", { name: "Properties" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Name"]);
    await userEvent.keyboard("{Enter}");
    expect(box).toHaveValue("UPPER({Name}");
    await userEvent.type(box, ")");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "formula", options: { expression: "UPPER({Name})", result_type: "text" } });
  });

  it("formula with a live check shows the server's verdict", async () => {
    const api = mockApi({
      "POST /api/tables/tbl1/formula/check": { ok: false, error: { message: "Unbalanced parentheses", pos: 3 } },
    });
    render(
      <Providers client={createQueryClient()}>
        <FieldDialog state={{ mode: "create" }} schema={schema} table={table} onOpenChange={() => {}} />
      </Providers>,
    );
    await pick("Formula");
    await userEvent.type(screen.getByRole("combobox", { name: "Formula" }), "SUM(1");
    expect(await screen.findByText("Unbalanced parentheses", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/formula/check").length).toBeGreaterThan(0);
  });

  it("rollup preset and lookup/count references", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Emails");
    await pick("Rollup");
    await userEvent.selectOptions(screen.getByLabelText("Property to use from the linked collection"), "fld_pe");
    await userEvent.selectOptions(screen.getByLabelText("Aggregation"), 'ARRAYJOIN(values, ", ")');
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "rollup", options: { link_field_id: "fld_link", target_field_id: "fld_pe", expression: 'ARRAYJOIN(values, ", ")' } });
  });

  it("count needs only a link field", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "How many");
    await pick("Count");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "count", options: { link_field_id: "fld_link" } });
  });

  it("button label and URL formula", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Visit");
    await pick("Button");
    await userEvent.clear(screen.getByLabelText("Button label"));
    await userEvent.type(screen.getByLabelText("Button label"), "Go");
    await userEvent.type(screen.getByRole("combobox", { name: "URL formula" }), '"https://x.y/"');
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "button", options: { label: "Go", url_formula: '"https://x.y/"' } });
  });

  it.each([
    ["Rich text", "rich_text", {}],
    ["Duration", "duration", { format: "h_mm" }],
    ["Checkbox", "checkbox", { icon: "check", color: "green" }],
    ["Email", "email", {}],
    ["URL", "url", {}],
    ["Phone number", "phone", {}],
    ["Attachment", "attachment", {}],
    ["Created time", "created_time", { include_time: false, date_format: "us", time_format: "h12", timezone: null }],
    ["Created by", "created_by", {}],
    ["Autonumber", "autonumber", {}],
    ["Barcode", "barcode", {}],
  ] as const)("%s sends its default options", async (label, type, options) => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "X1");
    await pick(label);
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type, options });
  });

  it("reports server errors in the dialog", async () => {
    mockApi({ "POST /api/tables/tbl1/fields": { status: 400, json: { error: { code: "bad", message: "Field limit reached" } } } });
    render(
      <Providers client={createQueryClient()}>
        <FieldDialog state={{ mode: "create" }} schema={schema} table={table} onOpenChange={() => {}} />
      </Providers>,
    );
    await userEvent.type(screen.getByLabelText("Name"), "Z");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Field limit reached");
  });
});

describe("FieldDialog: edit", () => {
  const qty: Field = { ...field("number", { precision: 0, allow_negative: true }, { id: "fld_n", name: "Qty" }) };

  it("sends only what changed", async () => {
    const { api, onOpenChange } = setup({ mode: "edit", field: qty });
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Quantity");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.callsTo("PATCH /api/fields/fld_n")[0]!.body).toEqual({ name: "Quantity" });
  });

  it("closes without a request when nothing changed", async () => {
    const { api, onOpenChange } = setup({ mode: "edit", field: qty });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("warns before a lossy type change and requires confirmation", async () => {
    const text = field("text", { multiline: false }, { id: "fld_n", name: "Qty" });
    const { api } = setup({ mode: "edit", field: text });
    await pick("Number");
    expect(screen.getByRole("status")).toHaveTextContent(/cleared/);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Tick the box to continue.")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    await userEvent.click(screen.getByRole("checkbox", { name: /existing values may be lost/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/fields/fld_n")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/fields/fld_n")[0]!.body).toMatchObject({ type: "number", options: { precision: 0, allow_negative: true } });
  });

  it("warns that turning Multiline off joins lines", async () => {
    const address = field("text", { multiline: true }, { id: "fld_a", name: "Address" });
    const { api } = setup({ mode: "edit", field: address });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Multiline/ }));
    expect(screen.getByRole("status")).toHaveTextContent("Line breaks in existing values become spaces.");
    await userEvent.click(screen.getByRole("checkbox", { name: /existing values may be lost/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/fields/fld_a")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/fields/fld_a")[0]!.body).toEqual({ type: "text", options: { multiline: false } });
  });

  it("says what rich text keeps when it becomes text, and the other way", async () => {
    const notes = field("rich_text", {}, { id: "fld_r", name: "Notes" });
    setup({ mode: "edit", field: notes });
    await pick("Text");
    expect(screen.getByRole("status")).toHaveTextContent(/Formatting is removed.*Line breaks/);
    await userEvent.click(screen.getByRole("checkbox", { name: /Multiline/ }));
    expect(screen.getByRole("status")).not.toHaveTextContent(/Line breaks/);
    cleanup();
    setup({ mode: "edit", field: field("text", { multiline: false }, { id: "fld_t", name: "Title" }) });
    await pick("Rich text");
    expect(screen.getByRole("status")).toHaveTextContent(/keep the text they show/);
    expect(screen.queryByRole("checkbox", { name: /may be lost/ })).not.toBeInTheDocument();
  });

  it("does not warn for a safe conversion", async () => {
    setup({ mode: "edit", field: qty });
    await pick("Text");
    expect(screen.getByRole("status")).toHaveTextContent(/converted/);
    expect(screen.queryByRole("checkbox", { name: /may be lost/ })).not.toBeInTheDocument();
  });

  it("shows the types that can't be the title dimmed, with the reason, for the title property", async () => {
    setup({ mode: "edit", field: name });
    await userEvent.click(screen.getByRole("button", { name: /^Type/ }));
    const checkbox = screen.getByRole("option", { name: /^Checkbox/ });
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
    expect(checkbox).toHaveTextContent("Can't be the title");
    await userEvent.click(checkbox);
    expect(screen.getByRole("button", { name: /^Type/ })).toHaveTextContent("Text");
    expect(screen.getByRole("option", { name: /^Number/ })).not.toHaveAttribute("aria-disabled");
  });

  it("round-trips existing options of every editable type without changes", async () => {
    // Opening a field and saving without edits must not send a PATCH (the options survive the editor).
    for (const type of ["number", "currency", "percent", "duration", "rating", "checkbox", "single_select", "multiple_select", "date", "user", "rich_text", "text"] as const) {
      const f = { ...ALL_FIELDS[type], id: "fld_n", name: "N" } as Field;
      const { api, onOpenChange } = setup({ mode: "edit", field: f });
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(api.calls.filter((c) => c.method === "PATCH"), type).toHaveLength(0);
      cleanup();
    }
  });
});


describe("FieldDialog: what a type change clears", () => {
  const text = field("text", { multiline: false }, { id: "fld_n", name: "Qty" });

  it("counts the values that carry a value, for a change that converts them", async () => {
    setup({ mode: "edit", field: text });
    await pick("Number");
    expect(await screen.findByText("Up to 7 values may be cleared: the ones that don't fit.")).toBeInTheDocument();
  });

  it("says every value goes when the property becomes computed, and asks to confirm", async () => {
    const { api } = setup({ mode: "edit", field: text });
    await pick("Formula");
    expect(await screen.findByText("7 values will be cleared.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Formula" }), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Tick the box to continue.")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("asks the server for the count through the default view's filled summary", async () => {
    const { api } = setup({ mode: "edit", field: text });
    await pick("Link to another record");
    await screen.findByText("7 values will be cleared.");
    const call = api.callsTo("GET /api/views/viw1/aggregations")[0]!;
    expect(JSON.parse(call.query.get("transient")!)).toEqual({ filter: { conjunction: "and", items: [] }, summaries: { fld_n: "filled" } });
  });

  it("does not ask to confirm a change that has nothing to take away", async () => {
    const { api } = setup({ mode: "edit", field: text });
    api.set("GET /api/views/viw1/aggregations", { values: { fld_n: 0 } });
    await pick("Number");
    expect(await screen.findByText(/No record has a value in this property/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /may be lost/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/fields/fld_n")).toHaveLength(1));
  });

  it("still warns, without a number, when the count can't be read", async () => {
    const { api } = setup({ mode: "edit", field: text });
    api.set("GET /api/views/viw1/aggregations", { status: 500, json: { error: { code: "internal", message: "boom" } } });
    await pick("Number");
    expect(await screen.findByText("Values that don't fit will be cleared.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /may be lost/ })).toBeInTheDocument();
  });

  it("does not let a link property be pointed at another collection once it is made", async () => {
    const owner = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_n", name: "Owner" });
    setup({ mode: "edit", field: owner });
    expect(screen.getByLabelText("Collection to link to")).toBeDisabled();
    expect(screen.getByText("The linked collection can't be changed once the property is added.")).toBeInTheDocument();
  });

  it("says a property that is the page stops being it when its type changes, and that nothing is refused", async () => {
    const notes = field("rich_text", {}, { id: "fld_n", name: "Notes" });
    const pageTable = { ...table, fields: [name, link, notes], body_field_id: "fld_n" };
    const api = mockApi({ "PATCH /api/fields/fld_n": (call) => ({ id: "fld_n", table_id: "tbl1", name: "Notes", ...(call.body as object) }), "GET /api/views/viw1/aggregations": { values: { fld_n: 0 } } });
    const onOpenChange = vi.fn();
    render(
      <Providers client={createQueryClient()}>
        <FieldDialog state={{ mode: "edit", field: notes }} schema={{ ...schema, tables: [pageTable, people] }} table={pageTable} onOpenChange={onOpenChange} />
      </Providers>,
    );
    expect(screen.queryByText(/This is the collection's page/)).not.toBeInTheDocument();
    await pick("Text");
    expect(screen.getByText(/This is the collection's page/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /may be lost/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/fields/fld_n")).toHaveLength(1));
  });
});

describe("FieldDialog: the type list", () => {
  it("is one tab stop, with the arrow keys moving through the types", async () => {
    setup();
    await openTypePicker();
    const options = screen.getAllByRole("option");
    expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    options.find((o) => o.tabIndex === 0)!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(options[1]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(options.at(-1)).toHaveFocus();
    await userEvent.keyboard("{Home}{Enter}");
    expect(screen.getByRole("button", { name: /^Type/ })).toHaveTextContent("Text");
  });

  it("gives every type a one-line description, in the groups of the picker", async () => {
    setup();
    await openTypePicker();
    for (const group of ["Text", "Numbers", "Choices", "Dates and people", "Files and links", "Computed"]) expect(screen.getByRole("group", { name: group })).toBeInTheDocument();
    for (const option of screen.getAllByRole("option")) expect(option.querySelectorAll("span.block")).toHaveLength(2);
    expect(screen.getAllByRole("option")).toHaveLength(28);
  });
});

describe("FieldDialog: on a phone", () => {
  it("is a full-screen sheet, and the type list is a bottom sheet of its own", async () => {
    stubPhone();
    setup({ mode: "create" });
    expect(screen.getByRole("dialog", { name: "Add property" })).toBeInTheDocument();
    // The list does not open over the form by itself.
    expect(screen.queryByRole("dialog", { name: "Property type" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Type/ }));
    const sheet = await screen.findByRole("dialog", { name: "Property type" });
    expect(screen.queryByRole("listbox", { name: "Property types" })).toBe(within(sheet).getByRole("listbox", { name: "Property types" }));
    await userEvent.click(within(sheet).getByRole("option", { name: /^Number/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Property type" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Type/ })).toHaveTextContent("Number");
  });
});

describe("FieldDialog: Change type", () => {
  it("opens with the type list showing", () => {
    setup({ mode: "edit", field: field("number", { precision: 0, allow_negative: true }, { id: "fld_n", name: "Qty" }), focus: "type" });
    expect(screen.getByRole("listbox", { name: "Property types" })).toBeInTheDocument();
  });

  it("opens the type sheet at once on a phone", async () => {
    stubPhone();
    setup({ mode: "edit", field: field("number", { precision: 0, allow_negative: true }, { id: "fld_n", name: "Qty" }), focus: "type" });
    expect(await screen.findByRole("dialog", { name: "Property type" })).toBeInTheDocument();
  });
});

describe("FieldDialog: the link target (FLD-5)", () => {
  it("lists the folder's collections by color mark, never an icon, and picks by name", async () => {
    const user = userEvent.setup();
    schema.tables[1]!.color = "orange";
    schema.tables[1]!.icon = "truck";
    try {
      const { api } = setup();
      await user.type(screen.getByLabelText("Name"), "Team");
      await pick("Link to another record");
      const target = screen.getByLabelText("Collection to link to");
      // The first collection of the folder is the default target, with its mark.
      expect(target.querySelector(".ob-mark")).toBeInTheDocument();
      expect(target.querySelector("svg.lucide-truck")).toBeNull();
      await user.click(target);
      const options = await screen.findAllByRole("option");
      // Only collections of this folder: the schema is the folder's, so nothing else can be offered.
      expect(options.map((o) => o.textContent)).toEqual(["Tasks (this collection)", "People"]);
      expect(options[1]!.querySelector(".ob-mark.ob-hue-orange")).toBeInTheDocument();
      expect(options[1]!.querySelector("svg.lucide-truck")).toBeNull();
      await user.click(options[0]!);
      await user.click(screen.getByRole("button", { name: "Add property" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
      expect(body(api)).toMatchObject({ type: "link", options: { linked_table_id: "tbl1" } });
    } finally {
      schema.tables[1]!.icon = undefined;
    }
  });

  it("says collections in other folders can't be linked, before and after the property is made", async () => {
    setup();
    await pick("Link to another record");
    expect(screen.getByLabelText("Collection to link to")).toHaveAccessibleDescription("Collections in other folders can't be linked.");
    cleanup();
    const owner = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_n", name: "Owner" });
    setup({ mode: "edit", field: owner });
    const target = screen.getByLabelText("Collection to link to");
    expect(target).toHaveAccessibleDescription("The linked collection can't be changed once the property is added. Collections in other folders can't be linked.");
  });

  it("offers a lookup, rollup or count only the link properties of this collection", async () => {
    setup();
    await pick("Lookup");
    const links = screen.getByLabelText("Link property");
    expect(within(links).getAllByRole("option").map((o) => o.textContent)).toEqual(["Owner"]);
  });
});

describe("FieldDialog: choices (FLD-6)", () => {
  it("gives each new choice the next palette color, skipping the ones in use", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Stage");
    await pick("Single select");
    await userEvent.click(screen.getByRole("button", { name: "Add option" }));
    await userEvent.keyboard("Alpha{Enter}Beta{Enter}Gamma");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    const choices = (body(api).options as { choices: { name: string; color: string }[] }).choices;
    expect(choices.map((c) => c.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(new Set(choices.map((c) => c.color)).size).toBe(3);
    expect(choices.map((c) => c.color)).toEqual(COLORS.slice(0, 3));
  });

  it("recolors a choice from the list of colors in a pop-over, keeping its pastel pair on the dot", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Name"), "Stage");
    await pick("Single select");
    await userEvent.click(screen.getByRole("button", { name: "Add option" }));
    await userEvent.keyboard("Alpha");
    const dot = screen.getByRole("button", { name: "Color of option Alpha" });
    expect(dot.firstElementChild).toHaveClass(`choice-${COLORS[0]}`);
    await userEvent.click(dot);
    await userEvent.click(await screen.findByRole("radio", { name: /^Purple$/ }));
    expect(screen.getByRole("button", { name: "Color of option Alpha" }).firstElementChild).toHaveClass("choice-purple");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect((body(api).options as { choices: { color: string }[] }).choices[0]!.color).toBe("purple");
  });

  it("opens the list of colors as a bottom sheet on a phone, and picking closes it", async () => {
    stubPhone();
    setup();
    await userEvent.type(screen.getByLabelText("Name"), "Stage");
    await userEvent.click(screen.getByRole("button", { name: /^Type/ }));
    await userEvent.click(await screen.findByRole("option", { name: /^Single select/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add option" }));
    await userEvent.click(screen.getByRole("button", { name: /^Color of option/ }));
    const sheet = await screen.findByRole("dialog", { name: "Choice color" });
    await userEvent.click(within(sheet).getByRole("radio", { name: /^Teal$/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choice color" })).toBeNull());
    expect(screen.getByRole("button", { name: /^Color of option/ }).firstElementChild).toHaveClass("choice-teal");
  });
});

describe("FieldDialog: the formula editor (FLD-5)", () => {
  it("moves through the suggested properties with the arrows and takes the one lit with Enter", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Name"), "Pair");
    await pick("Formula");
    const box = screen.getByRole("combobox", { name: "Formula" });
    await userEvent.type(box, "{{");
    const list = await screen.findByRole("listbox", { name: "Properties" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Name", "Owner"]);
    expect(box).toHaveAttribute("aria-activedescendant", options[0]!.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(box).toHaveAttribute("aria-activedescendant", options[1]!.id);
    await userEvent.keyboard("{Enter}");
    expect(box).toHaveValue("{Owner}");
    expect(screen.queryByRole("listbox", { name: "Properties" })).toBeNull();
  });

  it("announces the live check through a polite region", async () => {
    mockApi({ "POST /api/tables/tbl1/formula/check": { ok: true, preview: "7" } });
    render(
      <Providers client={createQueryClient()}>
        <FieldDialog state={{ mode: "create" }} schema={schema} table={table} onOpenChange={() => {}} />
      </Providers>,
    );
    await pick("Formula");
    await userEvent.type(screen.getByRole("combobox", { name: "Formula" }), "3 + 4");
    const verdict = await screen.findByText(/Looks good/, {}, { timeout: 3000 });
    expect(verdict.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    expect(verdict).toHaveTextContent("preview: 7");
  });
});
