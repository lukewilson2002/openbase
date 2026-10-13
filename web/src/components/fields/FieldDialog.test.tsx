import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Field } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import { makeSchema, mockApi } from "@/test/utils";
import { FieldDialog, type FieldDialogState } from "./FieldDialog";

const link = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_link", name: "Owner" });
const name = field("single_line_text", {}, { id: "fld_name", name: "Name" });
const table = makeTable([name, link]);
const people = makeTable([field("single_line_text", {}, { id: "fld_p", name: "Person" }), field("email", {}, { id: "fld_pe", name: "Email" })], { id: "tbl2", name: "People" });
const schema = { ...makeSchema("owner"), tables: [table, people] };

function setup(state: FieldDialogState = { mode: "create" }) {
  const api = mockApi({
    "POST /api/tables/tbl1/fields": (call) => ({ status: 201, json: { id: "fld_new", table_id: "tbl1", ...(call.body as object) } }),
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

const body = (api: ReturnType<typeof mockApi>) => api.callsTo("POST /api/tables/tbl1/fields")[0]!.body as Record<string, unknown>;

async function openTypePicker() {
  const toggle = screen.queryByRole("listbox", { name: "Field types" });
  if (!toggle) await userEvent.click(screen.getByRole("button", { name: /Field type/ }));
}

async function pick(label: string) {
  await openTypePicker();
  const list = screen.getByRole("listbox", { name: "Field types" });
  await userEvent.click(within(list).getByText(label, { selector: "span.font-medium" }));
}

describe("FieldDialog: create", () => {
  it("creates a single line text field with empty options", async () => {
    const { api, onSaved, onOpenChange } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Title");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body(api)).toEqual({ name: "Title", description: null, type: "single_line_text", options: {} });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("validates before sending", async () => {
    const { api } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    expect(await screen.findByText("Give the field a name.")).toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(0);
    await userEvent.type(screen.getByLabelText("Field name"), "Name");
    expect(screen.getByText(/already has that name/)).toBeInTheDocument();
  });

  it("number options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Qty");
    await pick("Number");
    await userEvent.selectOptions(screen.getByLabelText("Precision"), "3");
    await userEvent.click(screen.getByRole("checkbox", { name: "Allow negative numbers" }));
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "number", options: { precision: 3, allow_negative: false } });
  });

  it("currency options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Price");
    await pick("Currency");
    await userEvent.click(screen.getByRole("button", { name: "Use €" }));
    await userEvent.selectOptions(screen.getByLabelText("Precision"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "currency", options: { symbol: "€", precision: 0, allow_negative: true } });
  });

  it("single select choices: add, rename, reorder, delete", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Stage");
    await pick("Single select");
    await userEvent.click(screen.getByRole("button", { name: "Add option" }));
    await userEvent.keyboard("Alpha{Enter}Beta{Enter}Gamma");
    expect(screen.getAllByLabelText(/Name of option/)).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Move Gamma up" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    const choices = ((body(api).options as { choices: { name: string; color: string; id: string }[] }).choices);
    expect(choices.map((c) => c.name)).toEqual(["Gamma", "Beta"]);
    expect(choices.every((c) => c.id === "" && c.color)).toBe(true);
  });

  it("rejects duplicate option names", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Stage");
    await pick("Multiple select");
    await userEvent.click(screen.getByRole("button", { name: "Add option" }));
    await userEvent.keyboard("A{Enter}a");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    expect(await screen.findByText("Option names must be unique.")).toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(0);
  });

  it("date options including time and a fixed zone", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Starts");
    await pick("Date");
    await userEvent.selectOptions(screen.getByLabelText("Date format"), "iso");
    await userEvent.click(screen.getByRole("checkbox", { name: "Include a time field" }));
    await userEvent.selectOptions(screen.getByLabelText("Time format"), "h24");
    await userEvent.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "date", options: { include_time: true, date_format: "iso", time_format: "h24", timezone: "America/New_York" } });
  });

  it("link options and inverse name", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Team");
    await pick("Link to another record");
    expect(screen.getByLabelText("Table to link to")).toHaveValue("tbl2");
    await userEvent.click(screen.getByRole("checkbox", { name: "Allow linking to only one record" }));
    await userEvent.type(screen.getByLabelText(/Name of the field created in the linked table/), "Tasks here");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "link", inverse_name: "Tasks here", options: { linked_table_id: "tbl2", single: true, inverse_field_id: "" } });
  });

  it("user options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Reviewers");
    await pick("User");
    await userEvent.click(screen.getByRole("checkbox", { name: "Allow adding multiple users" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Notify people when they are added" }));
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "user", options: { multiple: true, notify: true } });
  });

  it("rating options", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Stars");
    await pick("Rating");
    await userEvent.selectOptions(screen.getByLabelText("Maximum rating"), "10");
    await userEvent.selectOptions(screen.getByLabelText("Icon"), "heart");
    await userEvent.click(screen.getByRole("radio", { name: "Red" }));
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "rating", options: { max: 10, icon: "heart", color: "red" } });
  });

  it("formula: autocomplete after { and the payload; the live check being absent does not block saving", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Shout");
    await pick("Formula");
    const box = screen.getByRole("combobox", { name: "Formula" });
    await userEvent.type(box, "UPPER({{Na");
    const list = await screen.findByRole("listbox", { name: "Fields" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Name"]);
    await userEvent.keyboard("{Enter}");
    expect(box).toHaveValue("UPPER({Name}");
    await userEvent.type(box, ")");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
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
    await userEvent.type(screen.getByLabelText("Field name"), "Emails");
    await pick("Rollup");
    await userEvent.selectOptions(screen.getByLabelText("Field to use from the linked table"), "fld_pe");
    await userEvent.selectOptions(screen.getByLabelText("Aggregation"), 'ARRAYJOIN(values, ", ")');
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "rollup", options: { link_field_id: "fld_link", target_field_id: "fld_pe", expression: 'ARRAYJOIN(values, ", ")' } });
  });

  it("count needs only a link field", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "How many");
    await pick("Count");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "count", options: { link_field_id: "fld_link" } });
  });

  it("button label and URL formula", async () => {
    const { api } = setup();
    await userEvent.type(screen.getByLabelText("Field name"), "Visit");
    await pick("Button");
    await userEvent.clear(screen.getByLabelText("Button label"));
    await userEvent.type(screen.getByLabelText("Button label"), "Go");
    await userEvent.type(screen.getByRole("combobox", { name: "URL formula" }), '"https://x.y/"');
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1));
    expect(body(api)).toMatchObject({ type: "button", options: { label: "Go", url_formula: '"https://x.y/"' } });
  });

  it.each([
    ["Long text", "long_text", { rich: false }],
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
    await userEvent.type(screen.getByLabelText("Field name"), "X1");
    await pick(label);
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
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
    await userEvent.type(screen.getByLabelText("Field name"), "Z");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Field limit reached");
  });
});

describe("FieldDialog: edit", () => {
  const qty: Field = { ...field("number", { precision: 0, allow_negative: true }, { id: "fld_n", name: "Qty" }) };

  it("sends only what changed", async () => {
    const { api, onOpenChange } = setup({ mode: "edit", field: qty });
    await userEvent.clear(screen.getByLabelText("Field name"));
    await userEvent.type(screen.getByLabelText("Field name"), "Quantity");
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
    const text = field("single_line_text", {}, { id: "fld_n", name: "Qty" });
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

  it("does not warn for a safe conversion", async () => {
    setup({ mode: "edit", field: qty });
    await pick("Single line text");
    expect(screen.getByRole("status")).toHaveTextContent(/converted/);
    expect(screen.queryByRole("checkbox", { name: /may be lost/ })).not.toBeInTheDocument();
  });

  it("only offers types that can be primary for the primary field", async () => {
    setup({ mode: "edit", field: name });
    await userEvent.click(screen.getByRole("button", { name: /Field type/ }));
    expect(screen.queryByRole("option", { name: /^Checkbox/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Link to another record/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Number/ })).toBeInTheDocument();
  });

  it("round-trips existing options of every editable type without changes", async () => {
    // Opening a field and saving without edits must not send a PATCH (the options survive the editor).
    for (const type of ["number", "currency", "percent", "duration", "rating", "checkbox", "single_select", "multiple_select", "date", "user", "long_text", "single_line_text"] as const) {
      const f = { ...ALL_FIELDS[type], id: "fld_n", name: "N" } as Field;
      const { api, onOpenChange } = setup({ mode: "edit", field: f });
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(api.calls.filter((c) => c.method === "PATCH"), type).toHaveLength(0);
      cleanup();
    }
  });
});

