/** "Add property" on the record page (REC-4, FLD-1 wiring): the box, the guessed type, the value, Escape, roles. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { field, makeRecord, makeTable } from "@/test/fields";
import { apiError } from "@/test/utils";
import { PATCH_RECORDS, renderRecordPage } from "@/test/recordPage";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const company = field("text", { multiline: false }, { id: "fld_company", name: "Company" });
const table = makeTable([name, company]);
const record = makeRecord({ fld_name: "Harper & Co", fld_company: "Acme" });
const POST_FIELD = "POST /api/tables/tbl1/fields";

const labels = () => [...screen.getByRole("region", { name: "Properties" }).querySelectorAll("dt")].map((dt) => dt.textContent);
const ready = () => screen.findByRole("button", { name: "Edit Company" });
const box = () => screen.getByRole("group", { name: "Add property" });
const open = async () => {
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "Add property" }));
  return within(box());
};
const created = (api: ReturnType<typeof renderRecordPage>["api"]) => api.callsTo(POST_FIELD).map((c) => c.body as Record<string, unknown>);
const written = (api: ReturnType<typeof renderRecordPage>["api"]) => api.callsTo(PATCH_RECORDS).map((c) => (c.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values);

describe("who sees Add property", () => {
  it("creators do, at the foot of the properties", async () => {
    renderRecordPage({ table, record, role: "creator" });
    await ready();
    expect(screen.getByRole("button", { name: "Add property" })).toBeInTheDocument();
  });

  it.each(["editor", "commenter", "viewer"])("a %s does not", async (role) => {
    renderRecordPage({ table, record, role });
    await screen.findByRole("region", { name: "Properties" });
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Add property" })).not.toBeInTheDocument();
  });
});

describe("the box", () => {
  it("has a Name and a Value, the type it guesses and Change type, and puts the keyboard in Name", async () => {
    renderRecordPage({ table, record });
    const b = await open();
    expect(b.getByRole("textbox", { name: "Name" })).toHaveFocus();
    expect(b.getByRole("textbox", { name: "Value" })).toBeInTheDocument();
    expect(b.getByText("Text")).toBeInTheDocument();
    expect(b.getByRole("button", { name: "Change type" })).toBeInTheDocument();
  });

  it("says what the value looks like as it is typed: Date · Guessed from “Nov 14”", async () => {
    renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "Nov 14");
    expect(b.getByText("Date · Guessed from “Nov 14”")).toBeInTheDocument();
    await userEvent.clear(b.getByRole("textbox", { name: "Value" }));
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "dana@harperco.example");
    expect(b.getByText(/^Email · Guessed from “dana@harperco.example”/)).toBeInTheDocument();
    await userEvent.clear(b.getByRole("textbox", { name: "Value" }));
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "+1 870 555 0100");
    expect(b.getByText(/^Phone number · Guessed from/)).toBeInTheDocument();
  });

  it("announces the guess politely and ties it to the Value", async () => {
    renderRecordPage({ table, record });
    const b = await open();
    const chip = b.getByText("Text").parentElement!;
    expect(chip).toHaveAttribute("aria-live", "polite");
    expect(b.getByRole("textbox", { name: "Value" })).toHaveAccessibleDescription("Text");
  });

  it("shortens a long value in the chip", async () => {
    renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "Harper and Sons Incorporated and Daughters");
    expect(b.getByText(/Guessed from “Harper and Sons Incorpo…”/)).toBeInTheDocument();
  });
});

describe("adding", () => {
  it("makes the property with the guessed type and sets this record's value, on Enter in the Value", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Renewal");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "2026-11-14{Enter}");
    await waitFor(() => expect(written(api)).toHaveLength(1));
    expect(created(api)).toEqual([{ name: "Renewal", description: null, type: "date", options: expect.objectContaining({ include_time: false }) }]);
    expect(written(api)[0]).toEqual({ fld_new1: "2026-11-14" });
    // It closes, and the property is the last row of the list.
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add property" })).not.toBeInTheDocument());
    await waitFor(() => expect(labels()).toEqual(["Company", "Renewal"]));
  });

  it("also adds on Enter in the Name, and with the Add property button", async () => {
    const { api } = renderRecordPage({ table, record });
    let b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Notes{Enter}");
    await waitFor(() => expect(created(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject({ name: "Notes", type: "text", options: { multiline: false } });
    // Nothing typed as a value: the property is made and no value is written.
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add property" })).not.toBeInTheDocument());
    expect(written(api)).toEqual([]);
    b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Other");
    await userEvent.click(b.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(created(api)).toHaveLength(2));
  });

  it.each([
    ["a rating written as stars", "★★★", { type: "rating", options: { max: 5, icon: "star", color: "yellow" } }, 3],
    ["a checkbox written as yes", "yes", { type: "checkbox", options: { icon: "check", color: "green" } }, true],
    ["a checkbox written as a check mark", "✓", { type: "checkbox" }, true],
    ["an amount of money", "$600", { type: "currency", options: { precision: 2, symbol: "$", allow_negative: true } }, 600],
    ["a percentage", "15%", { type: "percent" }, 0.15],
    ["a duration", "1:30", { type: "duration", options: { format: "h_mm" } }, 5400],
    ["a plain number with commas and decimals", "1,250.5", { type: "number", options: { precision: 1, allow_negative: true } }, 1250.5],
    ["an email address", "dana@harperco.example", { type: "email" }, "dana@harperco.example"],
    ["a web address", "harperco.example/book", { type: "url" }, "https://harperco.example/book"],
    ["a phone number", "+1 870 555 0100", { type: "phone" }, "+1 870 555 0100"],
    ["plain text", "Harper", { type: "text", options: { multiline: false } }, "Harper"],
  ])("takes %s", async (_what, typed, expectedType, cell) => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Thing");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), `${typed}{Enter}`);
    await waitFor(() => expect(written(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject(expectedType);
    expect(written(api)[0]).toEqual({ fld_new1: cell });
  });

  it("makes a checkbox for a cross without ticking it", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Paid");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "✗{Enter}");
    await waitFor(() => expect(created(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject({ type: "checkbox" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add property" })).not.toBeInTheDocument());
    expect(written(api)).toEqual([]);
  });

  it("reads a date with a time as a date with a time", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Call");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "2026-11-14 9am{Enter}");
    await waitFor(() => expect(written(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject({ type: "date", options: { include_time: true } });
    expect(written(api)[0]).toEqual({ fld_new1: "2026-11-14T09:00:00.000Z" });
  });

  it("closes the box and shows the value on the page", async () => {
    renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Stage");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "Harper{Enter}");
    expect(await screen.findByRole("button", { name: "Edit Stage" })).toHaveTextContent("Harper");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add property" })).toHaveFocus());
  });
});

describe("Change type", () => {
  const pick = async (b: ReturnType<typeof within>, label: RegExp) => {
    await userEvent.click(b.getByRole("button", { name: "Change type" }));
    await userEvent.click(await screen.findByRole("option", { name: label }));
  };

  it("offers every type, in groups, links and choices included", async () => {
    renderRecordPage({ table, record });
    const b = await open();
    await userEvent.click(b.getByRole("button", { name: "Change type" }));
    const list = await screen.findByRole("listbox", { name: "Property types" });
    expect(within(list).getAllByRole("option")).toHaveLength(28);
    for (const label of [/^Link to another record/, /^Single select/, /^Multiple select/, /^Formula/]) expect(within(list).getByRole("option", { name: label })).toBeInTheDocument();
  });

  it("makes the property the type that was chosen and says so in the chip", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Code");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "2024");
    expect(b.getByText(/^Number · Guessed from/)).toBeInTheDocument();
    await pick(b, /^Text/);
    expect(b.getByText("Text · You chose this type")).toBeInTheDocument();
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "{Enter}");
    await waitFor(() => expect(written(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject({ type: "text" });
    expect(written(api)[0]).toEqual({ fld_new1: "2024" });
  });

  it("keeps the decimals typed when a number is chosen by hand", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Weight");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "3.75");
    await pick(b, /^Percent/);
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "{Enter}");
    await waitFor(() => expect(written(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject({ type: "percent", options: { precision: 2 } });
    expect(written(api)[0]).toEqual({ fld_new1: 0.0375 });
  });

  it("makes a choice property whose first choice is the typed value", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Stage");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "Open");
    await pick(b, /^Single select/);
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "{Enter}");
    await waitFor(() => expect(written(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject({ type: "single_select", options: { choices: [{ id: "", name: "Open", color: expect.any(String) }] } });
    expect(written(api)[0]).toEqual({ fld_new1: "chs_new0" });
  });

  it("makes a multiple select with a choice for each name", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Tags");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "red, blue");
    await pick(b, /^Multiple select/);
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "{Enter}");
    await waitFor(() => expect(written(api)).toHaveLength(1));
    expect((created(api)[0]!.options as { choices: { name: string }[] }).choices.map((c) => c.name)).toEqual(["red", "blue"]);
    expect(written(api)[0]).toEqual({ fld_new1: ["chs_new0", "chs_new1"] });
  });

  it("refuses a value the chosen type cannot hold, before making anything", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Count");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "plenty");
    await pick(b, /^Number/);
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "{Enter}");
    expect(await b.findByText(/plenty" is not a number/)).toBeInTheDocument();
    expect(created(api)).toHaveLength(0);
    // The box stays open for the correction.
    expect(box()).toBeInTheDocument();
  });

  it("continues in the property dialog, name filled in, for a type that needs setting up", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Total");
    await pick(b, /^Formula/);
    expect(b.getByRole("textbox", { name: "Value" })).toBeDisabled();
    await userEvent.click(b.getByRole("button", { name: "Add property" }));
    const dialog = await screen.findByRole("dialog", { name: "Add property" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Total");
    expect(within(dialog).getByRole("button", { name: /^Type/ })).toHaveTextContent("Formula");
    expect(created(api)).toHaveLength(0);
  });

  it("leaves the value off for a property that fills itself in", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Made");
    await pick(b, /^Created time/);
    expect(b.getByRole("textbox", { name: "Value" })).toBeDisabled();
    expect(b.getByRole("textbox", { name: "Value" })).toHaveAttribute("placeholder", "Filled in by OpenBase");
    await userEvent.click(b.getByRole("button", { name: "Add property" }));
    await waitFor(() => expect(created(api)).toHaveLength(1));
    expect(created(api)[0]).toMatchObject({ type: "created_time" });
    expect(written(api)).toEqual([]);
  });
});

describe("checks and failures", () => {
  it("asks for a name and makes nothing", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "x{Enter}");
    expect(await b.findByText("Give the property a name.")).toBeInTheDocument();
    expect(b.getByRole("textbox", { name: "Name" })).toHaveFocus();
    expect(created(api)).toHaveLength(0);
  });

  it("refuses a name another property has", async () => {
    const { api } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "company{Enter}");
    expect(await b.findByText("Another property in this collection already has that name.")).toBeInTheDocument();
    expect(created(api)).toHaveLength(0);
  });

  it("shows what the server said and stays open", async () => {
    const { api } = renderRecordPage({ table, record, routes: { [POST_FIELD]: apiError(400, "bad", "Property limit reached") } });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "More{Enter}");
    expect(await b.findByRole("alert")).toHaveTextContent("Property limit reached");
    expect(api.callsTo(POST_FIELD)).toHaveLength(1);
    expect(box()).toBeInTheDocument();
  });

  it("says when the property was made but its value was not set", async () => {
    renderRecordPage({ table, record, routes: { [PATCH_RECORDS]: apiError(400, "bad", "Nope") } });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Stage");
    await userEvent.type(b.getByRole("textbox", { name: "Value" }), "Harper{Enter}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add property" })).not.toBeInTheDocument());
    // The value that could not be saved stays in its row with the reason.
    expect(await screen.findByText("Nope")).toBeInTheDocument();
  });
});

describe("cancelling", () => {
  it("Escape closes the box, makes nothing, and does not leave the page", async () => {
    const { api, props } = renderRecordPage({ table, record });
    const b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Draft");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Add property" })).not.toBeInTheDocument();
    expect(created(api)).toHaveLength(0);
    expect(props.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add property" })).toHaveFocus());
  });

  it("Escape from the Change type button cancels the box too, not the page", async () => {
    const { props } = renderRecordPage({ table, record });
    const b = await open();
    b.getByRole("button", { name: "Change type" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Add property" })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Escape in the type list closes the list only", async () => {
    renderRecordPage({ table, record });
    const b = await open();
    await userEvent.click(b.getByRole("button", { name: "Change type" }));
    await screen.findByRole("listbox", { name: "Property types" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Property types" })).not.toBeInTheDocument());
    expect(box()).toBeInTheDocument();
  });

  it("Cancel closes it and the next opening starts empty", async () => {
    renderRecordPage({ table, record });
    let b = await open();
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Draft");
    await userEvent.click(b.getByRole("button", { name: "Cancel" }));
    b = await open();
    expect(b.getByRole("textbox", { name: "Name" })).toHaveValue("");
  });
});

describe("on a phone", () => {
  it("stacks the inputs at 44 px, and Change type opens a sheet", async () => {
    renderRecordPage({ table, record, phone: true });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    const b = within(box());
    expect(b.getByRole("textbox", { name: "Name" })).toHaveClass("max-md:h-control-touch");
    expect(b.getByRole("textbox", { name: "Value" })).toHaveClass("max-md:h-control-touch");
    await userEvent.type(b.getByRole("textbox", { name: "Name" }), "Due");
    await userEvent.click(b.getByRole("button", { name: "Change type" }));
    const sheet = await screen.findByRole("dialog", { name: "Property type" });
    await userEvent.click(within(sheet).getByRole("option", { name: /^Date/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Property type" })).not.toBeInTheDocument());
    expect(b.getByText("Date · You chose this type")).toBeInTheDocument();
  });
});
