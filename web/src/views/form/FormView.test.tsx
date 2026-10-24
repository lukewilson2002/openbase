import { useQuery } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/api/keys";
import type { View, ViewConfig } from "@/api/types";
import { apiError } from "@/test/utils";
import { F, projectSchema, renderView, viewWithConfig } from "../common/viewTestUtils";
import type { ViewProps } from "../types";
import FormView from "./FormView";

afterEach(() => vi.unstubAllGlobals());

const entry = (field_id: string, extra: Partial<ViewConfig["form"]["fields"][number]> = {}) => ({ field_id, required: false, label: null, help: null, ...extra });

function formView(form: Partial<ViewConfig["form"]> = {}, over: Partial<View> = {}): View {
  return viewWithConfig(
    "viw1",
    "form",
    { form: { title: "", description: "", fields: [entry(F.name.id, { required: true, label: "Your name", help: "As on your passport" }), entry(F.status.id), entry(F.owner.id), entry(F.deps.id)], submit_label: "", success_message: "", redirect_url: null, show_submit_another: false, notify_user_ids: [], ...form } },
    over,
  );
}

/** What BaseShell does: the view comes from the cached base schema, which saving a view updates. */
function Live(props: ViewProps) {
  const base = useQuery({ queryKey: keys.base(props.schema.id), queryFn: () => props.schema, initialData: props.schema, staleTime: Infinity });
  const table = base.data.tables[0]!;
  const view = table.views.find((v) => v.id === props.view.id) ?? props.view;
  return <FormView {...props} schema={base.data} table={table} view={view} />;
}

function setup(role: string, view = formView(), routes: Record<string, unknown> = {}) {
  return renderView(Live, { schema: projectSchema(role, [view]), viewId: "viw1", routes: { "PATCH /api/views/viw1": (call: { body: unknown }) => ({ ...view, config: (call.body as { config: ViewConfig }).config }), ...routes } as never });
}

/** The form config of the last PATCH. */
async function saved(api: ReturnType<typeof setup>["api"], n = 1): Promise<ViewConfig["form"]> {
  await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1").length).toBeGreaterThanOrEqual(n), { timeout: 3000 });
  const calls = api.callsTo("PATCH /api/views/viw1");
  return (calls[calls.length - 1]!.body as { config: ViewConfig }).config.form;
}

describe("the builder", () => {
  it("shows the settings, the fields with their overrides and a live preview", async () => {
    setup("creator");
    expect(await screen.findByRole("heading", { name: "Form" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Form fields" });
    expect(within(list).getAllByRole("listitem", { name: /^Form field / }).map((li) => li.getAttribute("aria-label"))).toEqual(["Form field Name", "Form field Status", "Form field Owner", "Form field Depends on"]);
    expect(screen.getByLabelText("Label for Name")).toHaveValue("Your name");
    expect(screen.getByLabelText("Help text for Name")).toHaveValue("As on your passport");

    const preview = screen.getByRole("region", { name: "Form preview" });
    // The preview uses the label override, the help text and a required marker, with the real editors.
    expect(within(preview).getByText("Your name")).toBeInTheDocument();
    expect(within(preview).getByText("As on your passport")).toBeInTheDocument();
    expect(within(preview).getByText("Fields marked * are required.")).toBeInTheDocument();
    expect(within(preview).getByRole("textbox", { name: "Your name" })).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { name: "form viw1" })).toBeInTheDocument(); // the view's name until a title is set
  });

  it("says which fields stay off the public form and can preview it without them", async () => {
    const user = userEvent.setup();
    setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    expect(screen.getAllByText("Not public")).toHaveLength(2); // Owner (user) and Depends on (link)
    expect(screen.getByText(/2 of 4 fields/)).toBeInTheDocument();
    const preview = screen.getByRole("region", { name: "Form preview" });
    expect(within(preview).getAllByText("Signed-in editors only")).toHaveLength(2);

    await user.click(screen.getByRole("switch", { name: "Public form only" }));
    expect(within(preview).queryByText("Signed-in editors only")).not.toBeInTheDocument();
    expect(within(preview).queryByText("Owner")).not.toBeInTheDocument();
    expect(within(preview).getByText("Status")).toBeInTheDocument();
  });

  it("saves the title, description, button, message and the submit-another switch", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    await user.type(screen.getByLabelText("Title"), "Contact us");
    await user.type(screen.getByLabelText("Description"), "We reply in a day");
    await user.type(screen.getByLabelText("Submit button"), "Send");
    await user.type(screen.getByLabelText("After submitting"), "Got it");
    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("switch", { name: /Submit another response/ }));
    const form = await saved(api);
    await waitFor(async () => expect((await saved(api)).show_submit_another).toBe(true), { timeout: 3000 });
    const last = await saved(api);
    expect(last).toMatchObject({ title: "Contact us", description: "We reply in a day", submit_label: "Send", success_message: "Got it", show_submit_another: true });
    expect(form.fields).toHaveLength(4);
    // The preview follows immediately.
    expect(within(screen.getByRole("region", { name: "Form preview" })).getByRole("heading", { name: "Contact us" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Form preview" })).getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("edits a field's label, help text and required flag", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    await user.clear(screen.getByLabelText("Label for Name"));
    // Rows are compact until opened; Name opened by itself because its label was changed.
    expect(screen.queryByLabelText("Label for Status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Status" }));
    await user.type(screen.getByLabelText("Label for Status"), "How far along?");
    await user.type(screen.getByLabelText("Help text for Status"), "Pick one");
    const row = screen.getByRole("listitem", { name: "Form field Status" });
    await user.click(within(row).getByRole("switch", { name: "Required" }));
    await waitFor(async () => expect((await saved(api)).fields.find((f) => f.field_id === F.status.id)?.required).toBe(true), { timeout: 3000 });
    const form = await saved(api);
    expect(form.fields.find((f) => f.field_id === F.name.id)).toMatchObject({ label: null, required: true });
    expect(form.fields.find((f) => f.field_id === F.status.id)).toMatchObject({ label: "How far along?", help: "Pick one", required: true });
  });

  it("removes, re-adds and reorders fields", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "Remove Owner from the form" }));
    await user.click(screen.getByRole("button", { name: "Edit Status" }));
    await user.click(screen.getByRole("button", { name: "Move Status down" }));
    await waitFor(async () => expect((await saved(api)).fields.map((f) => f.field_id)).toEqual([F.name.id, F.deps.id, F.status.id]), { timeout: 3000 });

    // Owner can be added back from the picker, to the place it had; computed-free tables offer every other field.
    await user.click(screen.getByRole("button", { name: "Add a field" }));
    expect((await screen.findAllByRole("menuitem")).map((o) => o.textContent?.trim())).toEqual(["Start", "End", "Owner", "Cover", "number", "Add all fields"]);
    await user.click(screen.getByRole("menuitem", { name: "Owner" }));
    await waitFor(async () => expect((await saved(api)).fields.map((f) => f.field_id)).toEqual([F.name.id, F.deps.id, F.owner.id, F.status.id]), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Add a field" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add all fields" }));
    await waitFor(async () => expect((await saved(api)).fields).toHaveLength(8), { timeout: 3000 });
  });

  it("does not offer computed fields", async () => {
    const view = formView();
    const schema = projectSchema("creator", [view]);
    schema.tables[0]!.fields = [...schema.tables[0]!.fields, { id: "f_total", table_id: "tbl1", name: "Total", type: "formula", options: { expression: "1", result_type: "number" } } as never];
    renderView(FormView, { schema, viewId: "viw1" });
    await screen.findByRole("heading", { name: "Form" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Add a field" }));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: "Total" })).not.toBeInTheDocument();
    expect(screen.getByText(/1 computed field cannot be asked/)).toBeInTheDocument();
  });

  it("accepts only http and https for the redirect and does not save anything else", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "More options" }));
    const redirect = screen.getByLabelText("After submitting, go to");
    await user.type(redirect, "javascript:alert(1)");
    await user.tab();
    expect(await screen.findByText("Only http:// and https:// addresses are allowed.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);

    await user.clear(redirect);
    await user.type(redirect, "https://example.com/thanks");
    const form = await saved(api);
    expect(form.redirect_url).toBe("https://example.com/thanks");
  });

  it("is read-only for editors on a locked view and for viewers", async () => {
    const user = userEvent.setup();
    setup("editor", formView({}, { locked: true }));
    await user.click(await screen.findByRole("button", { name: "Form" }));
    expect(await screen.findByText(/This view is locked/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Label for Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add a field" })).not.toBeInTheDocument();
    // Editors can still fill the form in.
    expect(screen.getByRole("button", { name: "Fill in form" })).toBeInTheDocument();
  });

  it("offers sharing to creators only", async () => {
    const user = userEvent.setup();
    setup("creator", formView(), { "GET /api/views/viw1/shares": [] });
    await user.click(await screen.findByRole("button", { name: "Share form" }));
    expect(await screen.findByRole("dialog", { name: /^Share / })).toBeInTheDocument();
  });

  it("hides sharing from editors", async () => {
    setup("editor");
    await screen.findByRole("button", { name: "Fill in form" });
    expect(screen.queryByRole("button", { name: "Share form" })).not.toBeInTheDocument();
  });
});

describe("filling in the form as a signed-in editor", () => {
  it("opens on the fill-in mode for people who cannot build, and creates a record", async () => {
    const user = userEvent.setup();
    const created = { records: [{ id: "recNew", table_id: "tbl1", created_at: 1, updated_at: 1, created_by: "usr1", updated_by: "usr1", autonumber: null, values: {} }] };
    const { api } = setup("editor", formView({ success_message: "Thanks for the answer", show_submit_another: true }, { locked: true }), { "POST /api/tables/tbl1/records": { status: 201, json: created } });
    const nameBox = await screen.findByRole("textbox", { name: "Your name" });
    expect(screen.getByRole("button", { name: "Fill in form", pressed: true })).toBeInTheDocument();
    await user.type(nameBox, "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Thanks for the answer")).toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1);
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toEqual({ records: [{ values: { [F.name.id]: "Ada" } }], typecast: true });
    // Another response starts from a blank form.
    await user.click(screen.getByRole("button", { name: "Submit another response" }));
    expect(await screen.findByRole("textbox", { name: "Your name" })).toHaveValue("");
  });

  it("will not send a form with a required field empty", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", formView({}, { locked: true }));
    await screen.findByRole("textbox", { name: "Your name" });
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("This field is required.")).toBeInTheDocument();
    expect(screen.getByText(/Some answers need attention/)).toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("shows what the server refused", async () => {
    const user = userEvent.setup();
    setup("editor", formView({}, { locked: true }), { "POST /api/tables/tbl1/records": apiError(400, "bad_request", "The table is full.") });
    await user.type(await screen.findByRole("textbox", { name: "Your name" }), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("The table is full.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  it("viewers see the form but have no fill-in mode", async () => {
    setup("viewer");
    await screen.findByRole("heading", { name: "Form" });
    expect(screen.queryByRole("button", { name: "Fill in form" })).not.toBeInTheDocument();
  });
});

describe("removing and re-adding a field", () => {
  const configured = () => formView({ fields: [entry(F.name.id, { required: true }), entry(F.status.id, { label: "How far along?", help: "Pick one", required: true }), entry(F.start.id)] });

  it("offers Undo, which puts the field back in its place with its label, help and required", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator", configured());
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "Remove Status from the form" }));
    expect(await screen.findByText("Status removed from the form")).toBeInTheDocument();
    await waitFor(async () => expect((await saved(api)).fields.map((f) => f.field_id)).toEqual([F.name.id, F.start.id]), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await saved(api, 2)).fields).toEqual([entry(F.name.id, { required: true }), entry(F.status.id, { label: "How far along?", help: "Pick one", required: true }), entry(F.start.id)]), { timeout: 3000 });
  });

  it("brings back the conditions that read a removed question with Undo", async () => {
    const user = userEvent.setup();
    const showIf = { conjunction: "and" as const, items: [{ field_id: F.status.id, op: "is" as const, value: "s1" }] };
    const { api } = setup("creator", formView({ fields: [entry(F.name.id), entry(F.status.id), entry(F.effort.id, { show_if: showIf })] }));
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "Remove Status from the form" }));
    // The condition goes with the question it read.
    await waitFor(async () => expect((await saved(api)).fields.find((f) => f.field_id === F.effort.id)?.show_if ?? null).toBeNull(), { timeout: 3000 });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await saved(api, 2)).fields.find((f) => f.field_id === F.effort.id)?.show_if).toEqual(showIf), { timeout: 3000 });
    expect((await saved(api, 2)).fields.map((f) => f.field_id)).toEqual([F.name.id, F.status.id, F.effort.id]);
  });

  it("brings a removed field back where it was when it is added again", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator", configured());
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "Remove Status from the form" }));
    await waitFor(async () => expect((await saved(api)).fields).toHaveLength(2), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Add a field" }));
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    await waitFor(async () => expect((await saved(api, 2)).fields.map((f) => f.field_id)).toEqual([F.name.id, F.status.id, F.start.id]), { timeout: 3000 });
    expect((await saved(api, 2)).fields[1]).toMatchObject({ label: "How far along?", help: "Pick one", required: true });
  });
});

describe("what can be required and what is hidden", () => {
  it("disables Required for link and user fields, with the reason", async () => {
    setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    for (const name of ["Owner", "Depends on"]) {
      const row = screen.getByRole("listitem", { name: `Form field ${name}` });
      expect(within(row).getByRole("switch", { name: /Required/ })).toBeDisabled();
      expect(within(row).getByRole("switch", { name: /cannot be required/ })).toBeInTheDocument();
    }
    expect(within(screen.getByRole("listitem", { name: "Form field Name" })).getByRole("switch", { name: "Required" })).toBeEnabled();
  });

  it("lets a link field that is required already be switched off", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator", formView({ fields: [entry(F.name.id), entry(F.deps.id, { required: true })] }));
    await screen.findByRole("heading", { name: "Form" });
    const sw = within(screen.getByRole("listitem", { name: "Form field Depends on" })).getByRole("switch", { name: "Required" });
    expect(sw).toBeEnabled();
    await user.click(sw);
    expect((await saved(api)).fields.find((f) => f.field_id === F.deps.id)?.required).toBe(false);
  });

  it("shows a field the form view hides on the public form again", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "form", { hidden_fields: [F.status.id], form: formView().config.form });
    const { api } = setup("creator", view);
    await screen.findByRole("heading", { name: "Form" });
    const row = screen.getByRole("listitem", { name: "Form field Status" });
    expect(within(row).getByText("Not public")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Show Status on the public form" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1").length).toBeGreaterThan(0), { timeout: 3000 });
    const body = api.callsTo("PATCH /api/views/viw1").at(-1)!.body as { config: ViewConfig };
    expect(body.config.hidden_fields).toEqual([]);
    expect(await within(screen.getByRole("listitem", { name: "Form field Status" })).findByText("Not public").catch(() => null)).toBeNull();
  });
});

describe("editors and a public link", () => {
  it("is read-only for an editor while the form has a public link", async () => {
    setup("editor", formView(), { "GET /api/views/viw1/share-status": { enabled: true } });
    expect(await screen.findByText(/public link/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Label for Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add a field" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fill in form" })).toBeInTheDocument();
  });

  it("stays editable for an editor when no link is on, and never asks creators", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", formView(), { "GET /api/views/viw1/share-status": { enabled: false } });
    await waitFor(() => expect(api.callsTo("GET /api/views/viw1/share-status")).toHaveLength(1));
    await user.type(screen.getByLabelText("Title"), "Hi");
    expect((await saved(api)).title).toBe("Hi");
    expect(screen.queryByText(/public link/)).not.toBeInTheDocument();

    const creator = setup("creator", formView(), { "GET /api/views/viw1/shares": [] });
    await screen.findAllByRole("heading", { name: "Form" });
    expect(creator.api.callsTo("GET /api/views/viw1/share-status")).toHaveLength(0);
  });
});

describe("Fill in form from the keyboard", () => {
  const created = { records: [{ id: "recNew", table_id: "tbl1", created_at: 1, updated_at: 1, created_by: "usr1", updated_by: "usr1", autonumber: null, values: {} }] };
  const post = { "POST /api/tables/tbl1/records": { status: 201, json: created } };

  it("sends on Enter in a one-line input", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", formView({}, { locked: true }), post);
    await user.type(await screen.findByRole("textbox", { name: "Your name" }), "Ada{Enter}");
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toEqual({ records: [{ values: { [F.name.id]: "Ada" } }], typecast: true });
  });

  it("sends on Ctrl+Enter from any control, and not on Enter from a button", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", formView({}, { locked: true }), post);
    await user.type(await screen.findByRole("textbox", { name: "Your name" }), "Ada");
    await user.tab();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
  });

  it("puts the cursor in the first field that needs attention", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", formView({ fields: [entry(F.name.id, { required: true }), entry(F.effort.id), entry(F.status.id, { required: true })] }, { locked: true }), post);
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findAllByText("This field is required.");
    expect(document.activeElement?.closest("[data-field-id]")?.getAttribute("data-field-id")).toBe(F.status.id);
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(0);
    // The first field is the one when it is the one missing.
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(document.activeElement?.closest("[data-field-id]")?.getAttribute("data-field-id")).toBe(F.name.id));
  });
});

describe("after submitting in Fill in form", () => {
  const created = { records: [{ id: "recNew", table_id: "tbl1", created_at: 1, updated_at: 1, created_by: "usr1", updated_by: "usr1", autonumber: null, values: {} }] };
  const post = { "POST /api/tables/tbl1/records": { status: 201, json: created } };
  const locked = { locked: true };

  function stubLocation() {
    const assign = vi.fn();
    const real = window.location;
    vi.stubGlobal("location", { ...real, assign, pathname: real.pathname, search: real.search, origin: real.origin });
    return assign;
  }

  it("offers Submit another only when the form says so", async () => {
    const user = userEvent.setup();
    setup("editor", formView({ show_submit_another: false }, locked), post);
    await user.type(await screen.findByRole("textbox", { name: "Your name" }), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText(/Thanks! Your response has been recorded/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit another response" })).not.toBeInTheDocument();
  });

  it("goes to the redirect address with the new record's id, with no message and no Submit another", async () => {
    const assign = stubLocation();
    const user = userEvent.setup();
    setup("editor", formView({ show_submit_another: true, redirect_url: "https://example.com/done?r={record_id}", success_message: "Nice" }, locked), post);
    await user.type(await screen.findByRole("textbox", { name: "Your name" }), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Taking you on…")).toBeInTheDocument();
    expect(assign).toHaveBeenCalledWith("https://example.com/done?r=recNew");
    expect(screen.queryByText("Nice")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit another response" })).not.toBeInTheDocument();
  });
});

describe("the builder preview", () => {
  const withFiles = () => formView({ fields: [entry(F.name.id, { required: true }), entry(F.status.id), entry(F.cover.id)], success_message: "All done", show_submit_another: true });

  it("cannot create select options or upload files", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator", withFiles());
    const preview = await screen.findByRole("region", { name: "Form preview" });
    expect(within(preview).getByText("Files cannot be added in the preview.")).toBeInTheDocument();
    expect(within(preview).queryByText("Add files…")).not.toBeInTheDocument();
    await user.click(within(preview).getByRole("button", { name: /Status/ }));
    const find = await screen.findByRole("combobox", { name: "Find an option in Status" });
    await user.type(find, "Blocked");
    expect(find).toHaveValue("Blocked");
    expect(screen.queryByRole("option", { name: /Create/ })).not.toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("can show the visitors' own inputs", async () => {
    const user = userEvent.setup();
    setup("creator", withFiles());
    const preview = await screen.findByRole("region", { name: "Form preview" });
    await user.click(screen.getByRole("switch", { name: "Public form only" }));
    // The native select and file picker of the public page, not the pop-over editors.
    expect(within(preview).getByRole("combobox", { name: /Status/ }).tagName).toBe("SELECT");
    expect(within(preview).getByLabelText(/Upload files for Cover/)).toBeInTheDocument();
  });

  it("checks the answers and shows what happens after submitting", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator", withFiles());
    const preview = await screen.findByRole("region", { name: "Form preview" });
    await user.click(within(preview).getByRole("button", { name: "Submit" }));
    expect(await within(preview).findByText("This field is required.")).toBeInTheDocument();
    await user.type(within(preview).getByRole("textbox", { name: "Name" }), "Ada");
    await user.click(within(preview).getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("All done")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit another response" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the form" }));
    expect(await screen.findByRole("region", { name: "Form preview" })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("says that a redirect replaces the message", async () => {
    const user = userEvent.setup();
    setup("creator", formView({ fields: [entry(F.name.id)], redirect_url: "https://example.com/thanks", show_submit_another: true }));
    const preview = await screen.findByRole("region", { name: "Form preview" });
    await user.type(within(preview).getByRole("textbox", { name: "Name" }), "Ada");
    await user.click(within(preview).getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Visitors are sent to another address")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/thanks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit another response" })).not.toBeInTheDocument();
  });
});

describe("the settings of what happens afterwards", () => {
  it("turns Submit another off and explains it while a redirect is set", async () => {
    setup("creator", formView({ redirect_url: "https://example.com/thanks", show_submit_another: true }));
    await screen.findByRole("heading", { name: "Form" });
    expect(screen.getByRole("switch", { name: /Submit another response/ })).toBeDisabled();
    expect(screen.getByText("Not offered while the form goes to another address.")).toBeInTheDocument();
    expect(screen.getByText("Not shown while the form goes to another address.")).toBeInTheDocument();
    expect(screen.getByText(/\{record_id\}/)).toBeInTheDocument();
  });
});

describe("headings and text between the fields", () => {
  it("adds a heading and a paragraph, edits their text, and shows them in the preview", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "Add a heading or text" }));
    await user.click(await screen.findByRole("menuitem", { name: "Section heading" }));
    await user.clear(screen.getByLabelText("Heading text"));
    await user.type(screen.getByLabelText("Heading text"), "About you");
    await user.click(screen.getByRole("button", { name: "Add a heading or text" }));
    await user.click(await screen.findByRole("menuitem", { name: "Text between fields" }));
    await user.clear(screen.getByLabelText("Text"));
    await user.type(screen.getByLabelText("Text"), "Tell us a bit");
    const preview = screen.getByRole("region", { name: "Form preview" });
    expect(within(preview).getByRole("heading", { name: "About you" })).toBeInTheDocument();
    expect(within(preview).getByText("Tell us a bit")).toBeInTheDocument();
    await waitFor(async () => expect((await saved(api)).fields.filter((f) => f.block).map((f) => [f.block, f.label ?? f.help])).toEqual([["heading", "About you"], ["text", "Tell us a bit"]]), { timeout: 3000 });
    const blocks = (await saved(api)).fields.filter((f) => f.block);
    expect(blocks[0]!.field_id).toMatch(/^blk/);
    expect(blocks[0]!.required).toBe(false);
  });

  it("moves a heading with the fields, removes it with Undo, and counts only the questions", async () => {
    const user = userEvent.setup();
    const form = { fields: [entry(F.name.id), entry("blk1", { block: "heading", label: "Details" }), entry(F.status.id)] };
    const { api } = setup("creator", formView(form));
    await screen.findByRole("heading", { name: "Form" });
    expect(screen.getByText("2 in the form")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move the heading Details up" }));
    await waitFor(async () => expect((await saved(api)).fields.map((f) => f.field_id)).toEqual(["blk1", F.name.id, F.status.id]), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Remove the heading Details from the form" }));
    await waitFor(async () => expect((await saved(api, 2)).fields.map((f) => f.field_id)).toEqual([F.name.id, F.status.id]), { timeout: 3000 });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await saved(api, 3)).fields.map((f) => f.field_id)).toEqual(["blk1", F.name.id, F.status.id]), { timeout: 3000 });
  });
});

describe("conditional questions", () => {
  const todo = { conjunction: "and" as const, items: [{ field_id: F.status.id, op: "is" as const, value: "s1" }] };
  const conditional = () => formView({ fields: [entry(F.name.id), entry(F.status.id), entry(F.effort.id, { required: true, show_if: todo })] });

  it("sets a condition on a question above, and offers only the ones above", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator", formView({ fields: [entry(F.name.id), entry(F.status.id), entry(F.effort.id)] }));
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "Edit number" }));
    const editor = screen.getByTestId(`show-if-${F.effort.id}`);
    await user.click(within(editor).getByRole("button", { name: "Add condition" }));
    // Name and Status are above number; number itself is not offered.
    const choices = within(within(editor).getByRole("combobox", { name: "Field" })).getAllByRole("option").map((o) => o.textContent);
    expect(choices).toEqual(["Name", "Status"]);
    await user.selectOptions(within(editor).getByRole("combobox", { name: "Field" }), F.status.id);
    await waitFor(async () => expect((await saved(api)).fields.find((f) => f.field_id === F.effort.id)?.show_if?.items[0]).toMatchObject({ field_id: F.status.id, op: "is" }), { timeout: 3000 });
    expect(within(screen.getByRole("listitem", { name: "Form field number" })).getByText("Conditional")).toBeInTheDocument();
  });

  it("says there is nothing to depend on for the first question", async () => {
    const user = userEvent.setup();
    setup("creator", formView({ fields: [entry(F.name.id), entry(F.status.id)] }));
    await screen.findByRole("heading", { name: "Form" });
    await user.click(screen.getByRole("button", { name: "Edit Name" }));
    expect(within(screen.getByTestId(`show-if-${F.name.id}`)).getByText(/Put a text, number, rating, checkbox or select question above/)).toBeInTheDocument();
  });

  it("hides the question in the preview until the answer above matches", async () => {
    const user = userEvent.setup();
    setup("creator", conditional());
    await screen.findByRole("heading", { name: "Form" });
    const preview = screen.getByRole("region", { name: "Form preview" });
    expect(within(preview).queryByText("number")).not.toBeInTheDocument();
    // Required, but hidden: the preview's Submit does not stop at it.
    await user.type(within(preview).getByRole("textbox", { name: "Name" }), "Ada");
    await user.click(within(preview).getByRole("button", { name: "Submit" }));
    expect(await screen.findByText(/Thanks/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the form" }));
    await user.click(within(screen.getByRole("region", { name: "Form preview" })).getByRole("button", { name: "Status" }));
    await user.click(within(within(await screen.findByRole("listbox", { name: "Status" })).getByRole("option", { name: "Todo" })).getByRole("button"));
    expect(await within(screen.getByRole("region", { name: "Form preview" })).findByText("number")).toBeInTheDocument();
  });

  it("fills in the form without the hidden question, and sends it once it is shown", async () => {
    const user = userEvent.setup();
    const created = { records: [{ id: "recNew", table_id: "tbl1", created_at: 1, updated_at: 1, created_by: "usr1", updated_by: "usr1", autonumber: null, values: {} }] };
    const view = formView({ fields: [entry(F.name.id), entry(F.status.id), entry(F.effort.id, { required: true, show_if: todo })], success_message: "Done", show_submit_another: true }, { locked: true });
    const { api } = setup("editor", view, { "POST /api/tables/tbl1/records": { status: 201, json: created } });
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Ada");
    expect(screen.queryByText("number")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Done");
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toEqual({ records: [{ values: { [F.name.id]: "Ada" } }], typecast: true });
  });
});

describe("field defaults and descriptions", () => {
  const described = { ...F.name, options: { multiline: false, default: "Acme" }, description: "Who is asking" };

  it("starts Fill in form with the default, shows the description as help, and sends a cleared default as empty", async () => {
    const user = userEvent.setup();
    const created = { records: [{ id: "recNew", table_id: "tbl1", created_at: 1, updated_at: 1, created_by: "usr1", updated_by: "usr1", autonumber: null, values: {} }] };
    const view = formView({ fields: [entry(F.name.id), entry(F.effort.id)] }, { locked: true });
    const schema = projectSchema("editor", [view]);
    schema.tables[0]!.fields = schema.tables[0]!.fields.map((f) => (f.id === F.name.id ? (described as never) : f));
    const api = renderView(FormView, { schema, viewId: "viw1", routes: { "POST /api/tables/tbl1/records": { status: 201, json: created } } }).api;
    const box = await screen.findByRole("textbox", { name: "Name" });
    expect(box).toHaveValue("Acme");
    expect(screen.getByText("Who is asking")).toBeInTheDocument();
    await user.clear(box);
    await user.type(screen.getByRole("textbox", { name: "number" }), "7");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText(/Thanks/);
    // Name was cleared: an explicit null, so the server does not put the default back.
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toEqual({ records: [{ values: { [F.name.id]: null, [F.effort.id]: 7 } }], typecast: true });
  });
});

describe("who is notified of responses", () => {
  it("turns on notifications for the signed-in person in one click, and lists the others", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator");
    await screen.findByRole("heading", { name: "Form" });
    const me = screen.getByRole("switch", { name: "Notify me of new responses" });
    await waitFor(() => expect(me).toBeEnabled());
    expect(me).not.toBeChecked();
    await user.click(me);
    await waitFor(async () => expect((await saved(api)).notify_user_ids).toEqual(["usr1"]), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(await screen.findByRole("switch", { name: /Grace Hopper/ }));
    await waitFor(async () => expect((await saved(api, 2)).notify_user_ids).toEqual(["usr1", "usr2"]), { timeout: 3000 });
  });

  it("stays available to an editor while the public link locks the rest of the form", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", formView(), { "GET /api/views/viw1/share-status": { enabled: true } });
    await screen.findByText(/public link/);
    expect(screen.getByLabelText("Title")).toBeDisabled();
    const me = screen.getByRole("switch", { name: "Notify me of new responses" });
    await waitFor(() => expect(me).toBeEnabled());
    await user.click(me);
    await waitFor(async () => expect((await saved(api)).notify_user_ids).toEqual(["usr1"]), { timeout: 3000 });
  });
});
