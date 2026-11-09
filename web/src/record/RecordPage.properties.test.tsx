/** The record page's property list (REC-3): order, the two folds, Hide from pages and Show on pages, and the label menu. */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CHOICES, field, makeRecord, makeTable } from "@/test/fields";
import { apiError, makeSchema } from "@/test/utils";
import { PATCH_RECORDS, PATCH_VIEW, renderRecordPage } from "@/test/recordPage";
import { RECORD_FOLDS_KEY } from "./useRecordFolds";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const company = field("text", { multiline: false }, { id: "fld_company", name: "Company" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const phone = field("phone", {}, { id: "fld_phone", name: "Phone" });
const notes = field("text", { multiline: false }, { id: "fld_notes", name: "Notes" });
const secret = field("text", { multiline: false }, { id: "fld_secret", name: "Secret" });
const internal = field("text", { multiline: false }, { id: "fld_internal", name: "Internal" });
const page = field("rich_text", {}, { id: "fld_page", name: "Page" });
const table = makeTable([name, company, status, phone, notes, secret, internal, page], { body_field_id: "fld_page" });
const record = makeRecord({ fld_name: "Harper & Co", fld_company: "Acme", fld_status: "chs2", fld_secret: "hush", fld_page: "Some text" });
const layout = { field_order: ["fld_status", "fld_company"], hidden_fields: ["fld_secret", "fld_internal", "fld_page"] };

const labels = () => [...screen.getByRole("region", { name: "Properties" }).querySelectorAll("dt")].map((dt) => dt.textContent);
const ready = () => screen.findByRole("button", { name: "Edit Company" });

describe("the property list", () => {
  it("lists the properties that have a value in the default view's order, without the title or the Page", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    expect(labels()).toEqual(["Status", "Company"]);
    expect(screen.queryByText("Some text")).not.toBeInTheDocument();
  });

  it("is a definition list of labels and values", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    const dl = screen.getByRole("region", { name: "Properties" }).querySelector("dl")!;
    expect(dl.querySelectorAll(":scope > div > dt")).toHaveLength(2);
    expect(dl.querySelectorAll(":scope > div > dd")).toHaveLength(2);
  });
});

describe("a property's description", () => {
  it("is written under its name, where a touch screen can read it", async () => {
    const described = makeTable([name, { ...company, description: "The legal name, as on the invoice" }, status], { primary_field_id: "fld_name" });
    renderRecordPage({ table: described, record: makeRecord({ fld_name: "Harper", fld_company: "Acme", fld_status: "chs2" }) });
    await ready();
    const term = screen.getByRole("region", { name: "Properties" }).querySelector("dt:has(#property-fld_company)")!;
    expect(within(term as HTMLElement).getByText("The legal name, as on the invoice")).toBeVisible();
    // A property without one has no empty line.
    expect(screen.getByRole("region", { name: "Properties" }).querySelector("dt:has(#property-fld_status)")!.children).toHaveLength(1);
  });
});

describe("the empty properties fold", () => {
  it("counts the properties with nothing in them and keeps them out of sight until asked", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    const fold = screen.getByRole("button", { name: "Show 2 empty properties" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Edit Phone" })).not.toBeInTheDocument();
    await userEvent.click(fold);
    expect(screen.getByRole("button", { name: "Hide 2 empty properties" })).toHaveAttribute("aria-expanded", "true");
    expect(labels()).toEqual(["Status", "Company", "Phone", "Notes"]);
    expect(within(screen.getByRole("button", { name: "Edit Phone" })).getByText("Empty")).toBeInTheDocument();
  });

  it("is kept on this device: a page opened later has it open, and closing it is remembered too", async () => {
    const first = renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 empty properties" }));
    expect(JSON.parse(localStorage.getItem(RECORD_FOLDS_KEY)!)).toEqual({ tbl1: { empty: true } });
    first.unmount();
    renderRecordPage({ table, record, layout });
    expect(await screen.findByRole("button", { name: "Hide 2 empty properties" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide 2 empty properties" }));
    expect(JSON.parse(localStorage.getItem(RECORD_FOLDS_KEY)!)).toEqual({ tbl1: { empty: false } });
  });

  it("starts closed when storage cannot be read", async () => {
    localStorage.setItem(RECORD_FOLDS_KEY, "{not json");
    renderRecordPage({ table, record, layout });
    expect(await screen.findByRole("button", { name: "Show 2 empty properties" })).toBeInTheDocument();
  });

  it("says 'property' for one", async () => {
    renderRecordPage({ table: makeTable([name, company, notes]), record: makeRecord({ fld_name: "T", fld_company: "Acme" }) });
    expect(await screen.findByRole("button", { name: "Show 1 empty property" })).toBeInTheDocument();
  });

  it("is not there when every property has a value", async () => {
    renderRecordPage({ table: makeTable([name, company]), record: makeRecord({ fld_name: "T", fld_company: "Acme" }) });
    await ready();
    expect(screen.queryByRole("button", { name: /empty propert/ })).not.toBeInTheDocument();
  });

  it("lets the row of a property that was cleared stay where it is", async () => {
    const { api } = renderRecordPage({ table, record, layout });
    await userEvent.click(await ready());
    const box = await screen.findByRole("textbox", { name: "Company" });
    await userEvent.clear(box);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Edit Company" })).toHaveFocus();
    expect(labels()).toEqual(["Status", "Company"]);
    expect(screen.getByRole("button", { name: "Show 2 empty properties" })).toBeInTheDocument();
  });

  it("lists a property that gets a value", async () => {
    const { api } = renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 empty properties" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit Phone" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Phone" }), "+1 870 555 0100{Enter}");
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Hide 1 empty property" }));
    expect(labels()).toEqual(["Status", "Company", "Phone"]);
  });
});

describe("the hidden properties fold", () => {
  it("holds the properties the default view hides, and shows them read as the others are", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    const fold = screen.getByRole("button", { name: "Show 2 hidden properties" });
    expect(screen.queryByText("hush")).not.toBeInTheDocument();
    await userEvent.click(fold);
    expect(labels()).toEqual(["Status", "Company", "Secret", "Internal"]);
    expect(within(screen.getByRole("button", { name: "Edit Secret" })).getByText("hush")).toBeInTheDocument();
    // The Page is never one of them.
    expect(screen.queryByText("Page")).not.toBeInTheDocument();
  });

  it("is kept on this device apart from the empty one", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 hidden properties" }));
    expect(JSON.parse(localStorage.getItem(RECORD_FOLDS_KEY)!)).toEqual({ tbl1: { hidden: true } });
    expect(screen.getByRole("button", { name: "Show 2 empty properties" })).toBeInTheDocument();
  });

  it("brings a property back with Show on pages, at once and in the default view itself", async () => {
    const { api, server } = renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 hidden properties" }));
    await userEvent.click(screen.getByRole("button", { name: "Secret" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Show on pages" }));
    // Not a draft: the view is written as it is chosen.
    await waitFor(() => expect(api.callsTo(PATCH_VIEW)).toHaveLength(1));
    const sent = (api.callsTo(PATCH_VIEW)[0]!.body as { config: { hidden_fields: string[]; field_order: string[] } }).config;
    expect(sent.hidden_fields).toEqual(["fld_internal", "fld_page"]);
    expect(sent.field_order).toEqual(layout.field_order);
    await waitFor(() => expect(labels()).toEqual(["Status", "Company", "Secret", "Internal"]));
    // Secret is in the list now: the fold is for Internal alone.
    expect(screen.getByRole("button", { name: "Hide 1 hidden property" })).toBeInTheDocument();
    expect(server.schema().tables[0]!.views[0]!.config.hidden_fields).toEqual(["fld_internal", "fld_page"]);
  });

  it("takes a property off the page with Hide from pages, which then counts in the fold", async () => {
    const { api } = renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Hide from pages" }));
    await waitFor(() => expect(api.callsTo(PATCH_VIEW)).toHaveLength(1));
    expect((api.callsTo(PATCH_VIEW)[0]!.body as { config: { hidden_fields: string[] } }).config.hidden_fields).toEqual(["fld_secret", "fld_internal", "fld_page", "fld_company"]);
    expect(await screen.findByRole("button", { name: "Show 3 hidden properties" })).toBeInTheDocument();
    expect(labels()).toEqual(["Status"]);
  });

  it("sends two changes in a row as two layouts, the second holding the first", async () => {
    const { api } = renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Hide from pages" }));
    await userEvent.click(screen.getByRole("button", { name: "Status" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Hide from pages" }));
    await waitFor(() => expect(api.callsTo(PATCH_VIEW)).toHaveLength(2));
    expect((api.callsTo(PATCH_VIEW)[1]!.body as { config: { hidden_fields: string[] } }).config.hidden_fields).toEqual(["fld_secret", "fld_internal", "fld_page", "fld_company", "fld_status"]);
  });

  it("says so in the bar: Saving… while the layout goes out, then Saved", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    renderRecordPage({
      table,
      record,
      layout,
      routes: {
        [PATCH_VIEW]: async (call: { body: unknown }) => {
          await gate;
          return { ...table.views[0], config: (call.body as { config: unknown }).config };
        },
      },
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Hide from pages" }));
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Save status" })).toHaveAttribute("aria-live", "polite");
    act(() => release());
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("goes back to the saved layout and says it could not save when the server refuses", async () => {
    const { api } = renderRecordPage({ table, record, layout, routes: { [PATCH_VIEW]: apiError(403, "forbidden", "This view is locked") } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Hide from pages" }));
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    expect(await screen.findByText(/This view is locked/)).toBeInTheDocument();
    await waitFor(() => expect(labels()).toEqual(["Status", "Company"]));
    expect(api.callsTo(PATCH_VIEW)).toHaveLength(1);
  });
});

describe("a property's name", () => {
  it("opens its menu: Rename, Edit property and Delete for a creator, with Hide from pages", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent?.trim());
    expect(items).toEqual(["Rename", "Edit property", "Use as title", "Hide from pages", "Delete property"]);
  });

  it("offers no Hide and no Delete for the title when it is a row of its own (a choice), and says why Use as title is off", async () => {
    // A choice cannot be typed in the head, so the title is a row; it is still the title.
    const choiceTitle = makeTable([status, name, company], { primary_field_id: "fld_status" });
    renderRecordPage({ table: choiceTitle, record: makeRecord({ fld_status: "chs2", fld_name: "x" }) });
    await screen.findByRole("button", { name: "Edit Status" });
    await userEvent.click(screen.getByRole("button", { name: "Status" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent?.trim().replace(/\s+/g, " "))).toEqual(["Rename", "Edit property", "Use as titleIt is the title already", "Delete propertyThe title can't be deleted"]);
    expect(items[2]).toHaveAttribute("aria-disabled", "true");
    expect(items[3]).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: /Hide from pages/ })).not.toBeInTheDocument();
  });

  it("Use as title makes it the primary property, and the record's head then shows its value", async () => {
    let primary = "fld_name";
    const { api } = renderRecordPage({
      table,
      record,
      layout,
      routes: {
        "POST /api/tables/tbl1/primary-field": (call: { body: unknown }) => {
          primary = (call.body as { field_id: string }).field_id;
          return { id: "tbl1" };
        },
      },
    });
    // The folder comes back with the new title once the page asks for it again.
    const original = api.callsTo;
    expect(original).toBeDefined();
    await ready();
    api.set("GET /api/bases/app1", () => {
      const schema = JSON.parse(JSON.stringify(makeSchema("owner")));
      schema.tables[0] = { ...table, primary_field_id: primary, views: [{ ...table.views[0]!, is_default: true, config: { ...table.views[0]!.config, ...layout } }] };
      return schema;
    });
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Use as title" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/primary-field")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/primary-field")[0]!.body).toEqual({ field_id: "fld_company" });
    expect(await screen.findByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(await screen.findByText("“Company” is now the title")).toBeInTheDocument();
  });

  it("disables Use as title, with the reason, for a type that cannot be the title", async () => {
    const ticked = field("checkbox", { icon: "check", color: "green" }, { id: "fld_ok", name: "Reviewed" });
    renderRecordPage({ table: makeTable([name, company, ticked]), record: makeRecord({ fld_name: "T", fld_company: "Acme", fld_ok: true }) });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Reviewed" }));
    const item = await screen.findByRole("menuitem", { name: /Use as title/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Checkbox properties can't be the title");
  });

  it("offers Use as page on a rich text property only, and sends body-field", async () => {
    const notesRich = field("rich_text", {}, { id: "fld_rich", name: "Minutes" });
    const { api } = renderRecordPage({
      table: makeTable([name, company, notesRich], { body_field_id: null }),
      record: makeRecord({ fld_name: "T", fld_company: "Acme", fld_rich: "Hello" }),
      routes: { "POST /api/tables/tbl1/body-field": { id: "tbl1" } },
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    expect(screen.queryByRole("menuitem", { name: "Use as page" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Minutes" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Use as page" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/body-field")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/body-field")[0]!.body).toEqual({ field_id: "fld_rich" });
  });

  it("leaves Use as title and Use as page to creators", async () => {
    const notesRich = field("rich_text", {}, { id: "fld_rich", name: "Minutes" });
    renderRecordPage({ table: makeTable([name, company, notesRich]), record: makeRecord({ fld_name: "T", fld_company: "Acme", fld_rich: "Hello" }), role: "editor" });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Minutes" }));
    await screen.findByRole("menuitem", { name: "Hide from pages" });
    expect(screen.queryByRole("menuitem", { name: /Use as/ })).not.toBeInTheDocument();
  });

  it("does not edit the value", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(screen.queryByRole("textbox", { name: "Company" })).not.toBeInTheDocument();
  });

  it("Rename and Edit property open the property's dialog on its name", async () => {
    renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: /name/i })).toHaveValue("Company");
  });

  it("Delete asks first, then removes the property from the collection", async () => {
    const { api } = renderRecordPage({ table, record, layout, routes: { "DELETE /api/fields/fld_company": { ok: true } } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete property" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveAccessibleName("Delete property “Company”?");
    expect(api.callsTo("DELETE /api/fields/fld_company")).toHaveLength(0);
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete property" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/fields/fld_company")).toHaveLength(1));
    expect(await screen.findByText("Property “Company” deleted")).toBeInTheDocument();
  });

  it("gives up the delete on Cancel", async () => {
    const { api } = renderRecordPage({ table, record, layout });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete property" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(api.callsTo("DELETE /api/fields/fld_company")).toHaveLength(0);
  });
});

describe("the property list on a phone", () => {
  it("opens a property's menu as a sheet, and its rows are 44 px", async () => {
    renderRecordPage({ table, record, layout, phone: true });
    await ready();
    const row = screen.getByRole("button", { name: "Company" }).closest("div")!;
    expect(row).toHaveClass("max-md:min-h-control-touch");
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    const sheet = await screen.findByRole("dialog", { name: "Company" });
    expect(within(sheet).getByRole("button", { name: "Hide from pages" })).toBeInTheDocument();
  });

  it("keeps the folds on a 44 px line", async () => {
    renderRecordPage({ table, record, layout, phone: true });
    await ready();
    expect(screen.getByRole("button", { name: "Show 2 empty properties" })).toHaveClass("max-md:min-h-control-touch");
  });
});
