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
    { form: { title: "", description: "", fields: [entry(F.name.id, { required: true, label: "Your name", help: "As on your passport" }), entry(F.status.id), entry(F.owner.id), entry(F.deps.id)], submit_label: "", success_message: "", redirect_url: null, show_submit_another: false, ...form } },
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
    expect(within(screen.getByRole("region", { name: "Form preview" })).getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "true");
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

    // Owner can be added back from the picker; computed-free tables offer every other field.
    await user.click(screen.getByRole("button", { name: "Add a field" }));
    expect((await screen.findAllByRole("menuitem")).map((o) => o.textContent?.trim())).toEqual(["Start", "End", "Owner", "Cover", "number", "Add all fields"]);
    await user.click(screen.getByRole("menuitem", { name: "Owner" }));
    await waitFor(async () => expect((await saved(api)).fields.map((f) => f.field_id)).toEqual([F.name.id, F.deps.id, F.status.id, F.owner.id]), { timeout: 3000 });
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
    const { api } = setup("editor", formView({ success_message: "Thanks for the answer" }, { locked: true }), { "POST /api/tables/tbl1/records": { status: 201, json: created } });
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
