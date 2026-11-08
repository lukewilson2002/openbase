import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Field, Table } from "@/api/types";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { apiError, mockApi, renderWithProviders, stubDesktop, stubPhone } from "@/test/utils";
import { whyNotTitle } from "@/components/fields/propertyRoles";
import { CollectionSettings, isHomeDateProperty, settingsPatch } from "./CollectionSettings";

const named = (f: Field, id: string, name: string): Field => ({ ...f, id, name }) as Field;

const FIELDS = [
  named(ALL_FIELDS.text, "fld_name", "Name"),
  named(ALL_FIELDS.text, "fld_alt", "Nickname"),
  named(ALL_FIELDS.rich_text, "fld_notes", "Notes"),
  named(ALL_FIELDS.rich_text, "fld_page", "Page"),
  named(ALL_FIELDS.date, "fld_due", "Due"),
  named(ALL_FIELDS.date, "fld_start", "Start"),
  named(ALL_FIELDS.created_time, "fld_made", "Created"),
  named(ALL_FIELDS.formula, "fld_calc", "Total"),
  named(ALL_FIELDS.checkbox, "fld_done", "Done"),
  named(ALL_FIELDS.checkbox, "fld_flag", "Flagged"),
  named(ALL_FIELDS.attachment, "fld_files", "Files"),
  named(ALL_FIELDS.link, "fld_link", "Contact"),
];

const clients = (over: Partial<Table> = {}): Table =>
  makeTable(FIELDS, { name: "Clients", description: "People we work for", record_noun: "client", color: "orange", primary_field_id: "fld_name", body_field_id: "fld_page", home_date_field_id: "fld_due", done_field_id: "fld_done", ...over });

function open(table = clients(), { phone = false, routes = {} }: { phone?: boolean; routes?: Record<string, unknown> } = {}) {
  if (phone) stubPhone();
  else stubDesktop();
  const api = mockApi({
    "POST /api/tables/tbl1/primary-field": { id: "tbl1" },
    "POST /api/tables/tbl1/body-field": { id: "tbl1" },
    "PATCH /api/tables/tbl1": { id: "tbl1" },
    ...routes,
  } as never);
  const onOpenChange = vi.fn();
  renderWithProviders(<CollectionSettings table={table} baseId="app1" open onOpenChange={onOpenChange} />);
  return { api, onOpenChange };
}

const dialog = () => screen.getByRole("dialog", { name: "Collection settings" });
const optionsOf = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);

describe("which properties may play a part", () => {
  it("lets a date, a created or modified time, and a formula or rollup that gives a date show a collection on Home", () => {
    expect(isHomeDateProperty(ALL_FIELDS.date)).toBe(true);
    expect(isHomeDateProperty(ALL_FIELDS.created_time)).toBe(true);
    expect(isHomeDateProperty(ALL_FIELDS.last_modified_time)).toBe(true);
    const dateFormula = { ...ALL_FIELDS.formula, options: { ...ALL_FIELDS.formula.options, result_type: "date_time" } } as Field;
    expect(isHomeDateProperty(dateFormula)).toBe(true);
    // A number is not a date; neither is a list of them (a lookup of dates).
    expect(isHomeDateProperty(ALL_FIELDS.formula)).toBe(false);
    expect(isHomeDateProperty(ALL_FIELDS.lookup)).toBe(false);
    expect(isHomeDateProperty(ALL_FIELDS.text)).toBe(false);
  });

  it("refuses a title that is a link, attachment, checkbox, lookup, rollup, count, button, multiple select or rating, and says why", () => {
    for (const type of ["link", "attachment", "checkbox", "lookup", "rollup", "count", "button", "multiple_select", "rating"] as const) {
      expect(whyNotTitle(ALL_FIELDS[type])).toMatch(/can't be the title/);
    }
    expect(whyNotTitle(ALL_FIELDS.attachment)).toBe("Attachment properties can't be the title");
    for (const type of ["text", "rich_text", "number", "date", "single_select", "formula", "email", "autonumber"] as const) {
      expect(whyNotTitle(ALL_FIELDS[type])).toBeNull();
    }
  });
});

describe("settingsPatch", () => {
  const table = clients();
  const same = { name: "Clients", color: "orange", description: "People we work for", noun: "client", title: "fld_name", page: "fld_page", homeDate: "fld_due", done: "fld_done" };

  it("is empty when nothing changed", () => {
    expect(settingsPatch(table, same)).toEqual({ title: null, page: null, patch: null });
  });

  it("sends only what changed, trimmed, and clears a setting with null", () => {
    expect(settingsPatch(table, { ...same, name: "  Customers ", noun: "customer", homeDate: "", done: "" })).toEqual({ title: null, page: null, patch: { name: "Customers", record_noun: "customer", home_date_field_id: null, done_field_id: null } });
  });

  it("sends the title and the page to their own endpoints", () => {
    expect(settingsPatch(table, { ...same, title: "fld_alt", page: "" })).toEqual({ title: "fld_alt", page: { field_id: null }, patch: null });
  });

  it("clears the description with an empty string, which is what the server reads as none", () => {
    expect(settingsPatch(table, { ...same, description: "" }).patch).toEqual({ description: "" });
  });
});

describe("the collection settings", () => {
  it("holds name, color, description, record name, title, page, Home date and done, with the current values", () => {
    open();
    const d = within(dialog());
    expect(d.getByLabelText("Name")).toHaveValue("Clients");
    expect(d.getByRole("radiogroup", { name: "Color" })).toBeInTheDocument();
    expect(d.getByRole("radio", { checked: true })).toBeInTheDocument();
    expect(d.getByLabelText("Description")).toHaveValue("People we work for");
    expect(d.getByLabelText("Record name")).toHaveValue("client");
    expect(d.getByLabelText("Title property")).toHaveValue("fld_name");
    expect(d.getByLabelText("Page property")).toHaveValue("fld_page");
    expect(d.getByLabelText("Show on Home by")).toHaveValue("fld_due");
    expect(d.getByLabelText("Done property")).toHaveValue("fld_done");
  });

  it("offers each choice only the properties that fit it", () => {
    open();
    const d = within(dialog());
    // Title: every property, those that cannot be one disabled with the reason.
    const title = d.getByLabelText("Title property");
    expect(optionsOf(title)).toContain("Files (Attachment properties can't be the title)");
    expect(within(title).getByRole("option", { name: /^Files/ })).toBeDisabled();
    expect(within(title).getByRole("option", { name: /^Contact/ })).toBeDisabled();
    expect(within(title).getByRole("option", { name: "Nickname" })).toBeEnabled();
    // Page: rich text only, and not the title.
    expect(optionsOf(d.getByLabelText("Page property"))).toEqual(["None", "Notes", "Page"]);
    // Home date: dates and times, a formula only when it gives a date.
    expect(optionsOf(d.getByLabelText("Show on Home by"))).toEqual(["Not shown on Home", "Due", "Start", "Created"]);
    expect(optionsOf(d.getByLabelText("Done property"))).toEqual(["None", "Done", "Flagged"]);
  });

  it("reads the record name into the hint, so the button's wording is plain", async () => {
    const user = userEvent.setup();
    open(clients({ record_noun: "" }));
    expect(dialog()).toHaveTextContent('The button reads "New record"');
    await user.type(within(dialog()).getByLabelText("Record name"), "deal");
    expect(dialog()).toHaveTextContent('The button reads "New deal"');
  });

  it("saves nothing until something changes", async () => {
    const user = userEvent.setup();
    open();
    const save = within(dialog()).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.type(within(dialog()).getByLabelText("Record name"), "s");
    expect(save).toBeEnabled();
  });

  it("will not save with no name", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(within(dialog()).getByLabelText("Name"));
    expect(within(dialog()).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves the collection's own settings in one PATCH, and nothing else", async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = open();
    const d = within(dialog());
    const name = d.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Customers");
    await user.click(d.getByRole("radio", { name: "Teal" }));
    await user.selectOptions(d.getByLabelText("Show on Home by"), "");
    await user.selectOptions(d.getByLabelText("Done property"), "fld_flag");
    await user.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1")[0]?.body).toEqual({ name: "Customers", color: "teal", home_date_field_id: null, done_field_id: "fld_flag" });
    expect(api.callsTo("POST /api/tables/tbl1/primary-field")).toHaveLength(0);
    expect(api.callsTo("POST /api/tables/tbl1/body-field")).toHaveLength(0);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("changes the title property through the primary-field endpoint, the first UI for it", async () => {
    const user = userEvent.setup();
    const { api } = open();
    await user.selectOptions(within(dialog()).getByLabelText("Title property"), "fld_alt");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/primary-field")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/primary-field")[0]?.body).toEqual({ field_id: "fld_alt" });
    expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(0);
  });

  it("changes the page property through the body-field endpoint, and can set none", async () => {
    const user = userEvent.setup();
    const { api } = open();
    await user.selectOptions(within(dialog()).getByLabelText("Page property"), "fld_notes");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/body-field")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/body-field")[0]?.body).toEqual({ field_id: "fld_notes" });
  });

  it("keeps the dialog open and says what the server refused", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = open(clients(), { routes: { "PATCH /api/tables/tbl1": apiError(422, "validation_failed", "That record name is too long") } });
    await user.type(within(dialog()).getByLabelText("Record name"), "x");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText("That record name is too long")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(within(dialog()).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("closes with Cancel and with Escape, saving nothing", async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = open();
    await user.type(within(dialog()).getByLabelText("Record name"), "s");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await user.keyboard("{Escape}");
    expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(0);
  });

  it("is a full-screen sheet on a phone, with every control in it", () => {
    open(clients(), { phone: true });
    const d = within(dialog());
    for (const label of ["Name", "Description", "Record name", "Title property", "Page property", "Show on Home by", "Done property"]) expect(d.getByLabelText(label)).toBeInTheDocument();
    expect(d.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
