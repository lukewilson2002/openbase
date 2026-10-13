/**
 * The editor against a mocked API: every trigger type and every action type is built through the UI
 * and the exact PATCH payload is compared with the DTO the server expects (docs/automations.md).
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionStep, Automation, Trigger } from "@/api/types";
import { useQuery } from "@tanstack/react-query";
import { api as endpoints } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { apiError, chooseOption, mockApi, type Handler, type MockApi } from "@/test/utils";
import { AutomationEditor } from "./AutomationEditor";
import { automationSchema, makeAutomation, makeEnv, renderWithEnv } from "./testUtils";

afterEach(() => vi.unstubAllGlobals());

const PATH = "PATCH /api/automations/aut1";

type Extra = { token?: string; failWith?: ReturnType<typeof apiError> };

/**
 * The editor inside a stand-in for its page: the automation comes from the cached list, which a
 * save updates, exactly as `AutomationsPage` does. The mocked server keeps what was last saved.
 */
function Harness({ onWebhookToken }: { onWebhookToken: (t: string) => void }) {
  const list = useQuery({ queryKey: keys.automations("app1"), queryFn: () => endpoints.automations.list("app1") });
  const automation = list.data?.[0];
  if (!automation) return null;
  return <AutomationEditor automation={automation} tab="editor" onTabChange={() => {}} webhookToken={null} onWebhookToken={onWebhookToken} />;
}

async function setup(initial: Automation, env = makeEnv(), extra: Extra = {}) {
  let current = initial;
  const mock = mockApi({
    "GET /api/bases/app1/automations": () => [current],
    [PATH]: (call: { body: unknown }) => {
      if (extra.failWith) return extra.failWith;
      const body = call.body as Partial<Automation> & { rotate_webhook_token?: boolean };
      const { rotate_webhook_token: _r, ...patch } = body;
      current = { ...current, ...patch };
      return { ...current, webhook_token: extra.token ?? null };
    },
    "GET /api/automations/aut1/runs": { runs: [], total: 0 },
  } satisfies Record<string, Handler>);
  const onWebhookToken = vi.fn();
  renderWithEnv(<Harness onWebhookToken={onWebhookToken} />, env);
  await screen.findByRole("button", { name: "Save" });
  return { api: mock, onWebhookToken };
}

/** The body of the last save. */
function saved(api: MockApi): { name: string; trigger: Trigger; actions: ActionStep[] } {
  const calls = api.callsTo(PATH);
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)!.body as never;
}

async function save(api: MockApi) {
  const before = api.callsTo(PATH).length;
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.callsTo(PATH).length).toBe(before + 1));
  return saved(api);
}

const card = (n: number) => screen.getByRole("listitem", { name: new RegExp(`^Action ${n}:`) });

async function addAction(label: string) {
  await userEvent.click(screen.getByRole("button", { name: "Add action" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: new RegExp(label) }));
}

/** Paste text with braces (user-event treats "{" in `type` as a key descriptor). */
async function paste(el: HTMLElement, text: string) {
  await userEvent.click(el);
  await userEvent.paste(text);
}

describe("saving and the draft", () => {
  it("keeps Save disabled until something changes and offers Discard", async () => {
    await setup(makeAutomation());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), "!");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Flow");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("sends name, trigger and actions only, with the name trimmed", async () => {
    const { api } = await setup(makeAutomation());
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "  Renamed ");
    expect(await save(api)).toEqual({ name: "Renamed", trigger: { type: "record_created", table_id: "tbl1" }, actions: [] });
  });

  it("turns Save off again after a save and says so", async () => {
    const { api } = await setup(makeAutomation());
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await save(api);
    expect(await screen.findByText("Automation saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("turns the automation on and off on its own, without sending the draft", async () => {
    const { api } = await setup(makeAutomation());
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("switch", { name: "Off" }));
    await waitFor(() => expect(api.callsTo(PATH)).toHaveLength(1));
    expect(api.callsTo(PATH)[0]!.body).toEqual({ enabled: true });
  });
});

describe("triggers round-trip into the update payload", () => {
  it("record_created: another table", async () => {
    const { api } = await setup(makeAutomation());
    await chooseOption(screen.getByLabelText("Table"), "People");
    expect(await save(api)).toEqual({ name: "Flow", trigger: { type: "record_created", table_id: "tbl2" }, actions: [] });
  });

  it("record_updated: watched fields (editable only), and the table change resets them", async () => {
    const { api } = await setup(makeAutomation({ trigger: { type: "record_updated", table_id: "tbl1", field_ids: [] } }));
    expect(screen.queryByRole("checkbox", { name: "Double" })).not.toBeInTheDocument();
    expect(screen.getByText(/Any field/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Qty" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Status" }));
    expect((await save(api)).trigger).toEqual({ type: "record_updated", table_id: "tbl1", field_ids: ["fld2", "fld3"] });
    await userEvent.click(screen.getByRole("checkbox", { name: "Qty" }));
    expect((await save(api)).trigger).toEqual({ type: "record_updated", table_id: "tbl1", field_ids: ["fld3"] });
    await chooseOption(screen.getByLabelText("Table"), "People");
    expect((await save(api)).trigger).toEqual({ type: "record_updated", table_id: "tbl2", field_ids: [] });
  });

  it("record_matches: conditions from the filter builder", async () => {
    const { api } = await setup(makeAutomation({ trigger: { type: "record_matches", table_id: "tbl1", filter: { conjunction: "and", items: [] } } }));
    expect(screen.getByText(/every record matches/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
    await userEvent.selectOptions(screen.getByLabelText("Field"), "fld4");
    expect((await save(api)).trigger).toEqual({ type: "record_matches", table_id: "tbl1", filter: { conjunction: "and", items: [{ field_id: "fld4", op: "is", value: true }] } });
    await userEvent.click(screen.getByRole("button", { name: "Remove condition" }));
    expect((await save(api)).trigger).toEqual({ type: "record_matches", table_id: "tbl1", filter: { conjunction: "and", items: [] } });
  });

  it("form_submitted: a form view of any table", async () => {
    await setup(makeAutomation({ trigger: { type: "form_submitted", view_id: "viw9" } }));
    const form = screen.getByLabelText("Form");
    expect(form).toHaveTextContent("Tasks / Signup form");
    await userEvent.click(form);
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Tasks / Signup form"]);
  });

  it("schedule: presets build the cron, the time zone is sent as chosen", async () => {
    const { api } = await setup(makeAutomation({ trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" } }));
    expect(screen.getByLabelText("Repeat")).toHaveValue("daily");
    fireEvent.change(screen.getByLabelText("At"), { target: { value: "08:30" } });
    await userEvent.selectOptions(screen.getByLabelText("Time zone"), "Europe/Berlin");
    expect((await save(api)).trigger).toEqual({ type: "schedule", cron: "30 8 * * *", timezone: "Europe/Berlin" });

    await userEvent.selectOptions(screen.getByLabelText("Repeat"), "weekly");
    await userEvent.selectOptions(screen.getByLabelText("Day of the week"), "5");
    expect((await save(api)).trigger).toEqual({ type: "schedule", cron: "30 8 * * 5", timezone: "Europe/Berlin" });

    await userEvent.selectOptions(screen.getByLabelText("Repeat"), "monthly");
    await userEvent.selectOptions(screen.getByLabelText("Day of the month"), "15");
    expect((await save(api)).trigger).toMatchObject({ cron: "30 8 15 * *" });

    await userEvent.selectOptions(screen.getByLabelText("Repeat"), "hourly");
    expect((await save(api)).trigger).toMatchObject({ cron: "30 * * * *" });

    await userEvent.selectOptions(screen.getByLabelText("Repeat"), "every_minutes");
    await userEvent.selectOptions(screen.getByLabelText("Every"), "10");
    expect((await save(api)).trigger).toMatchObject({ cron: "*/10 * * * *" });
  });

  it("schedule: a raw cron expression is sent untouched and stays in custom mode while typing", async () => {
    const { api } = await setup(makeAutomation({ trigger: { type: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" } }));
    expect(screen.getByLabelText("Repeat")).toHaveValue("custom");
    const cron = screen.getByLabelText("Cron expression");
    expect(cron).toHaveValue("0 9 * * 1-5");
    await userEvent.clear(cron);
    await userEvent.type(cron, "0 9 * * *"); // looks like the daily preset, but the form must not jump under the cursor
    expect(screen.getByLabelText("Cron expression")).toHaveValue("0 9 * * *");
    expect(screen.getByLabelText("Repeat")).toHaveValue("custom");
    expect((await save(api)).trigger).toEqual({ type: "schedule", cron: "0 9 * * *", timezone: "UTC" });
  });

  it("schedule: shows the next run of a saved, enabled automation and explains when there is none", async () => {
    const at = Date.UTC(2026, 9, 19, 9, 0);
    await setup(makeAutomation({ enabled: true, next_run_at: at, trigger: { type: "schedule", cron: "0 9 * * 1", timezone: "UTC" } }));
    expect(screen.getByText(/next run/i)).toHaveTextContent(/2026/);
    expect(screen.getByText("Every Monday at 09:00")).toBeInTheDocument();
  });

  it("schedule: an off automation says it will not run", async () => {
    await setup(makeAutomation({ enabled: false, trigger: { type: "schedule", cron: "0 9 * * 1", timezone: "UTC" } }));
    expect(screen.getByText(/turn the automation on to schedule runs/)).toBeInTheDocument();
  });

  it("webhook: switching the trigger type sends a bare webhook trigger and reveals the token the server returns", async () => {
    const { api, onWebhookToken } = await setup(makeAutomation(), makeEnv(), { token: "obh_secret" });
    await userEvent.selectOptions(screen.getByLabelText("When this happens"), "webhook");
    expect(screen.getByText("Save the automation to get its private webhook URL.")).toBeInTheDocument();
    expect((await save(api)).trigger).toEqual({ type: "webhook" });
    await waitFor(() => expect(onWebhookToken).toHaveBeenCalledWith("obh_secret"));
  });

  it("form_submitted cannot be chosen when the base has no form view", async () => {
    const schema = automationSchema();
    schema.tables[0]!.views = schema.tables[0]!.views.filter((v) => v.type !== "form");
    await setup(makeAutomation(), makeEnv({ schema }));
    const option = within(screen.getByLabelText("When this happens")).getByRole("option", { name: /A form is submitted/ });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent("create a form view first");
  });
});

describe("actions round-trip into the update payload", () => {
  it("create_record: table, a template and typed values", async () => {
    const { api } = await setup(makeAutomation());
    await addAction("Create record");
    const c = card(1);
    await chooseOption(within(c).getByLabelText("Table"), "People");
    await userEvent.selectOptions(within(c).getByLabelText("Add a field"), "fld5");
    await paste(within(c).getByRole("textbox", { name: "Name" }), "{{trigger.record.fields.Name}}");
    await userEvent.selectOptions(within(c).getByLabelText("Add a field"), "fld6");
    const score = within(c).getByRole("textbox", { name: "Score" });
    await userEvent.type(score, "42");
    await userEvent.tab(); // the typed editor commits on blur
    await userEvent.selectOptions(within(c).getByLabelText("Add a field"), "fld7");
    await userEvent.click(within(c).getByRole("checkbox", { name: /Active/ }));
    expect((await save(api)).actions).toEqual([{ type: "create_record", table_id: "tbl2", values: { fld5: "{{trigger.record.fields.Name}}", fld6: 42, fld7: true } }]);
  });

  it("create_record: a number can be a template instead of a fixed value", async () => {
    const { api } = await setup(makeAutomation({ trigger: { type: "webhook" } }));
    await addAction("Create record");
    const c = card(1);
    await chooseOption(within(c).getByLabelText("Table"), "People");
    await userEvent.selectOptions(within(c).getByLabelText("Add a field"), "fld6");
    await userEvent.click(within(c).getByRole("button", { name: "Template" }));
    await paste(within(c).getByRole("textbox", { name: "Score" }), "{{trigger.body.score}}");
    expect((await save(api)).actions).toEqual([{ type: "create_record", table_id: "tbl2", values: { fld6: "{{trigger.body.score}}" } }]);
  });

  it("create_record: a select takes a choice id from its editor, and a choice name that is not an id opens as a template", async () => {
    const { api } = await setup(makeAutomation({ actions: [{ type: "create_record", table_id: "tbl1", values: { fld1: "x" } }] }));
    const c = card(1);
    await userEvent.selectOptions(within(c).getByLabelText("Add a field"), "fld3");
    await userEvent.click(within(c).getByRole("button", { name: "Status" }));
    await userEvent.click(within(await screen.findByRole("listbox", { name: "Status" })).getByRole("option", { name: "Done" }).querySelector("button")!);
    expect((await save(api)).actions).toEqual([{ type: "create_record", table_id: "tbl1", values: { fld1: "x", fld3: "chs3" } }]);
  });

  it("create_record: a stored choice name (typecast) is shown as editable text", async () => {
    await setup(makeAutomation({ actions: [{ type: "create_record", table_id: "tbl1", values: { fld3: "Brand new choice" } }] }));
    expect(within(card(1)).getByRole("textbox", { name: "Status" })).toHaveValue("Brand new choice");
    expect(within(card(1)).getByRole("button", { name: "Template" })).toHaveAttribute("aria-pressed", "true");
  });

  it("create_record: removing a value row drops the key, and changing the table clears the values", async () => {
    const { api } = await setup(makeAutomation({ actions: [{ type: "create_record", table_id: "tbl2", values: { fld5: "x", fld6: 3 } }] }));
    const c = card(1);
    await userEvent.click(within(c).getByRole("button", { name: "Remove Score" }));
    expect((await save(api)).actions).toEqual([{ type: "create_record", table_id: "tbl2", values: { fld5: "x" } }]);
    await chooseOption(within(c).getByLabelText("Table"), "Tasks");
    expect((await save(api)).actions).toEqual([{ type: "create_record", table_id: "tbl1", values: {} }]);
  });

  it("update_record: starts from the trigger record and sets values", async () => {
    const { api } = await setup(makeAutomation());
    await addAction("Update record");
    const c = card(1);
    expect(within(c).getByLabelText("Record id")).toHaveValue("{{trigger.record.id}}");
    await userEvent.selectOptions(within(c).getByLabelText("Add a field"), "fld1");
    await paste(within(c).getByRole("textbox", { name: "Name" }), "Seen");
    expect((await save(api)).actions).toEqual([{ type: "update_record", table_id: "tbl1", record_id: "{{trigger.record.id}}", values: { fld1: "Seen" } }]);
  });

  it("update_record: a record id from an earlier step", async () => {
    const { api } = await setup(makeAutomation({ actions: [{ type: "create_record", table_id: "tbl2", values: {} }] }));
    await addAction("Update record");
    const c = card(2);
    const id = within(c).getByLabelText("Record id");
    await userEvent.clear(id);
    await userEvent.click(within(c).getByRole("button", { name: "Insert data into Record id" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /record_id.*steps\.1\.record_id/ }));
    await chooseOption(within(c).getByLabelText("Table"), "People");
    await userEvent.selectOptions(within(c).getByLabelText("Add a field"), "fld5");
    await paste(within(c).getByRole("textbox", { name: "Name" }), "again");
    const actions = (await save(api)).actions;
    expect(actions[1]).toEqual({ type: "update_record", table_id: "tbl2", record_id: "{{steps.1.record_id}}", values: { fld5: "again" } });
  });

  it("send_email: to, subject and body", async () => {
    const { api } = await setup(makeAutomation());
    await addAction("Send email");
    const c = card(1);
    await userEvent.type(within(c).getByLabelText("To"), "ada@example.com, grace@example.com");
    await paste(within(c).getByLabelText("Subject"), "Hello {{trigger.record.fields.Name}}");
    await userEvent.type(within(c).getByLabelText("Body"), "Line one");
    expect((await save(api)).actions).toEqual([{ type: "send_email", to: "ada@example.com, grace@example.com", subject: "Hello {{trigger.record.fields.Name}}", body: "Line one" }]);
  });

  it("send_email is disabled in the add menu, with the reason, when the server has no SMTP", async () => {
    await setup(makeAutomation(), makeEnv({ emailEnabled: false }));
    await userEvent.click(screen.getByRole("button", { name: "Add action" }));
    const item = await screen.findByRole("menuitem", { name: /Send email/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("email is not configured on this server");
  });

  it("send_email already in the automation warns when email is not configured", async () => {
    await setup(makeAutomation({ actions: [{ type: "send_email", to: "a@b.co", subject: "s", body: "b" }] }), makeEnv({ emailEnabled: false }));
    expect(screen.getByText(/Email is not configured on this server/)).toBeInTheDocument();
  });

  it("http_request: method, URL, headers and body; GET has no body", async () => {
    const { api } = await setup(makeAutomation());
    await addAction("Send HTTP request");
    const c = card(1);
    await paste(within(c).getByLabelText("URL"), "https://example.com/hook/{{trigger.record.id}}");
    await userEvent.selectOptions(within(c).getByLabelText("Method"), "PUT");
    await userEvent.click(within(c).getByRole("button", { name: "Add header" }));
    await userEvent.type(within(c).getByLabelText("Header 1 name"), "Content-Type");
    await userEvent.type(within(c).getByRole("textbox", { name: "header 1 value" }), "application/json");
    await userEvent.click(within(c).getByRole("button", { name: "Add header" }));
    await userEvent.type(within(c).getByLabelText("Header 2 name"), "X-Blank");
    await userEvent.click(within(c).getByRole("button", { name: "Remove header 2" }));
    await paste(within(c).getByLabelText("Body"), '{"id": "{{trigger.record.id}}"}');
    expect((await save(api)).actions).toEqual([
      { type: "http_request", method: "PUT", url: "https://example.com/hook/{{trigger.record.id}}", headers: { "Content-Type": "application/json" }, body: '{"id": "{{trigger.record.id}}"}' },
    ]);
    await userEvent.selectOptions(within(c).getByLabelText("Method"), "GET");
    expect(within(c).queryByLabelText("Body")).not.toBeInTheDocument();
    expect(within(c).getByText("A GET request has no body.")).toBeInTheDocument();
  });

  it("http_request: leaves headers and body out when empty", async () => {
    const { api } = await setup(makeAutomation());
    await addAction("Send HTTP request");
    await userEvent.type(within(card(1)).getByLabelText("URL"), "https://example.com");
    expect((await save(api)).actions).toEqual([{ type: "http_request", method: "POST", url: "https://example.com", headers: {} }]);
  });

  it("notify: people from the base's collaborators and a message", async () => {
    const { api } = await setup(makeAutomation());
    await addAction("Notify people");
    const c = card(1);
    await userEvent.click(within(c).getByRole("checkbox", { name: /Grace Hopper/ }));
    await userEvent.click(within(c).getByRole("checkbox", { name: /Ada Lovelace/ }));
    await userEvent.type(within(c).getByLabelText("Message"), "New record");
    expect((await save(api)).actions).toEqual([{ type: "notify", user_ids: ["usr2", "usr1"], message: "New record" }]);
  });

  it("per-action conditions use the trigger table's fields and are removed when switched off", async () => {
    const { api } = await setup(makeAutomation({ actions: [{ type: "notify", user_ids: ["usr1"], message: "hi" }] }));
    const c = card(1);
    await userEvent.click(within(c).getByRole("checkbox", { name: /Only run this action/ }));
    await userEvent.click(within(c).getByRole("button", { name: "Add condition" }));
    expect(within(within(c).getByLabelText("Field")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Name", "Qty", "Status", "Done", "Double"]);
    await userEvent.selectOptions(within(c).getByLabelText("Field"), "fld4");
    expect((await save(api)).actions).toEqual([{ type: "notify", user_ids: ["usr1"], message: "hi", condition: { conjunction: "and", items: [{ field_id: "fld4", op: "is", value: true }] } }]);
    await userEvent.click(within(c).getByRole("checkbox", { name: /Only run this action/ }));
    expect((await save(api)).actions).toEqual([{ type: "notify", user_ids: ["usr1"], message: "hi" }]);
  });

  it("conditions are unavailable for triggers without a record", async () => {
    await setup(makeAutomation({ trigger: { type: "webhook" }, actions: [{ type: "notify", user_ids: ["usr1"], message: "hi" }] }));
    expect(within(card(1)).getByRole("checkbox", { name: /Only run this action/ })).toBeDisabled();
    expect(screen.getByText(/Conditions need a record or form trigger/)).toBeInTheDocument();
  });

  it("changing the trigger table drops conditions that name the old table's fields", async () => {
    const withCondition: ActionStep = { type: "notify", user_ids: ["usr1"], message: "hi", condition: { conjunction: "and", items: [{ field_id: "fld4", op: "is", value: true }] } };
    const { api } = await setup(makeAutomation({ actions: [withCondition] }));
    await chooseOption(screen.getAllByLabelText("Table")[0]!, "People");
    const body = await save(api);
    expect(body.trigger).toEqual({ type: "record_created", table_id: "tbl2" });
    expect(body.actions).toEqual([{ type: "notify", user_ids: ["usr1"], message: "hi" }]);
  });
});

describe("the action list", () => {
  const three: ActionStep[] = [
    { type: "notify", user_ids: ["usr1"], message: "one" },
    { type: "notify", user_ids: ["usr1"], message: "two" },
    { type: "notify", user_ids: ["usr1"], message: "three" },
  ];

  it("reorders and removes", async () => {
    const { api } = await setup(makeAutomation({ actions: three }));
    expect(screen.getByRole("button", { name: "Move action 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move action 3 down" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move action 1 down" }));
    expect((await save(api)).actions.map((a) => (a as { message: string }).message)).toEqual(["two", "one", "three"]);
    await userEvent.click(screen.getByRole("button", { name: "Move action 3 up" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove action 1" }));
    expect((await save(api)).actions.map((a) => (a as { message: string }).message)).toEqual(["three", "one"]);
  });

  it("explains an empty list", async () => {
    await setup(makeAutomation());
    expect(screen.getByText("No actions yet")).toBeInTheDocument();
    expect(screen.getByText("0 of 25 actions")).toBeInTheDocument();
  });

  it("stops at 25 actions", async () => {
    const many: ActionStep[] = Array.from({ length: 25 }, (_, i) => ({ type: "notify", user_ids: ["usr1"], message: `m${i}` }));
    await setup(makeAutomation({ actions: many }));
    expect(screen.getByRole("button", { name: "Add action" })).toBeDisabled();
    expect(screen.getByText(/25 of 25 actions: the limit is reached/)).toBeInTheDocument();
  });

  it("offers earlier steps' outputs to later actions only", async () => {
    await setup(makeAutomation({ actions: [{ type: "create_record", table_id: "tbl2", values: {} }, { type: "notify", user_ids: ["usr1"], message: "" }] }));
    await userEvent.click(within(card(2)).getByRole("button", { name: "Insert data into Message" }));
    const menu = await screen.findByRole("menu", { name: "Insert data" });
    expect(within(menu).getByText("Step 1: Create record")).toBeInTheDocument();
    expect(within(menu).queryByText(/Step 2/)).not.toBeInTheDocument();
  });
});

describe("server validation", () => {
  it("shows an action's error on that action", async () => {
    const { api } = await setup(makeAutomation({ actions: [{ type: "notify", user_ids: ["usr1"], message: "a" }, { type: "http_request", method: "GET", url: "ftp://x", headers: {} }] }), makeEnv(), { failWith: apiError(400, "bad_request", "action 2: the URL must start with http:// or https://") });
    await userEvent.type(within(card(2)).getByLabelText("URL"), "z");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(card(2)).findByText("the URL must start with http:// or https://")).toBeInTheDocument();
    expect(within(card(1)).queryByRole("alert")).not.toBeInTheDocument();
    expect(api.callsTo(PATH)).toHaveLength(1);
    // The draft stays dirty so the person can fix it, and the message goes away on the next edit.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await userEvent.type(within(card(2)).getByLabelText("URL"), "z");
    expect(within(card(2)).queryByText("the URL must start with http:// or https://")).not.toBeInTheDocument();
  });

  it("shows an error about a field value next to the values", async () => {
    await setup(makeAutomation({ actions: [{ type: "create_record", table_id: "tbl2", values: { fld6: "x" } }] }), makeEnv(), { failWith: apiError(400, "bad_request", 'action 1: field "Score": "x" is not a number') });
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(card(1)).findByText('field "Score": "x" is not a number')).toBeInTheDocument();
  });

  it("shows trigger and name errors at the top", async () => {
    await setup(makeAutomation({ trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" } }), makeEnv(), { failWith: apiError(400, "bad_request", 'invalid cron expression "nope"') });
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('invalid cron expression "nope"');
  });

  it("reports a failed on-switch as a toast", async () => {
    await setup(makeAutomation(), makeEnv(), { failWith: apiError(400, "bad_request", "add at least one action before turning the automation on") });
    await userEvent.click(screen.getByRole("switch", { name: "Off" }));
    expect(await screen.findByText("Could not turn the automation on")).toBeInTheDocument();
    expect(screen.getByText("add at least one action before turning the automation on")).toBeInTheDocument();
  });
});

describe("webhook panel", () => {
  const hook = makeAutomation({ enabled: true, trigger: { type: "webhook" } });

  it("shows the URL with the token once it is known, with a copy button", async () => {
    const api = mockApi({});
    void api;
    renderWithEnv(<AutomationEditor automation={hook} tab="editor" onTabChange={() => {}} webhookToken="obh_abc123" onWebhookToken={() => {}} />);
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(`${window.location.origin}/api/hooks/obh_abc123`);
    expect(screen.getByText(/Copy this URL now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument();
  });

  it("without the token it explains that it was shown once, and rotating asks first, then shows the new token", async () => {
    const onWebhookToken = vi.fn();
    mockApi({ [PATH]: { ...hook, webhook_token: "obh_rotated" } });
    renderWithEnv(<AutomationEditor automation={hook} tab="editor" onTabChange={() => {}} webhookToken={null} onWebhookToken={onWebhookToken} />);
    expect(screen.getByText(/shown once when it was created/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/old URL stops working immediately/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Rotate token" }));
    await waitFor(() => expect(onWebhookToken).toHaveBeenCalledWith("obh_rotated"));
  });

  it("sends rotate_webhook_token alone", async () => {
    const api = mockApi({ [PATH]: { ...hook, webhook_token: "obh_rotated" } });
    renderWithEnv(<AutomationEditor automation={hook} tab="editor" onTabChange={() => {}} webhookToken={null} onWebhookToken={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Rotate token" }));
    await waitFor(() => expect(api.callsTo(PATH)).toHaveLength(1));
    expect(api.callsTo(PATH)[0]!.body).toEqual({ rotate_webhook_token: true });
  });

  it("rotating is blocked while there are unsaved edits", async () => {
    mockApi({});
    renderWithEnv(<AutomationEditor automation={hook} tab="editor" onTabChange={() => {}} webhookToken={null} onWebhookToken={() => {}} />);
    await userEvent.type(screen.getByLabelText("Name"), "!");
    expect(screen.getByRole("button", { name: "Rotate token" })).toBeDisabled();
  });
});

describe("table icons in the automation editor", () => {
  const iconEnv = () => {
    const schema = automationSchema();
    schema.tables[0]!.icon = "clipboard-list";
    schema.tables[1]!.icon = "users";
    return makeEnv({ schema });
  };

  it("shows the table icons in the trigger's table select", async () => {
    await setup(makeAutomation(), iconEnv());
    const select = screen.getByLabelText("Table");
    expect(select.querySelector("svg.lucide-clipboard-list")).toBeInTheDocument();
    await userEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Tasks", "People"]);
    expect(options[1]!.querySelector("svg.lucide-users")).toBeInTheDocument();
  });

  it("shows the table icon in an action's table select", async () => {
    await setup(makeAutomation({ actions: [{ type: "create_record", table_id: "tbl2", values: {} }] }), iconEnv());
    expect(within(card(1)).getByLabelText("Table").querySelector("svg.lucide-users")).toBeInTheDocument();
  });

  it("names the form's table icon in the form trigger", async () => {
    await setup(makeAutomation({ trigger: { type: "form_submitted", view_id: "viw9" } }), iconEnv());
    expect(screen.getByLabelText("Form").querySelector("svg.lucide-clipboard-list")).toBeInTheDocument();
  });
});
