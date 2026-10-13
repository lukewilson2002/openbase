import { describe, expect, it } from "vitest";
import type { ActionStep, Automation, Trigger } from "@/api/types";
import { makeSchema, makeView } from "@/test/utils";
import { actionSummary, actionsPayload, canonicalJson, draftFromAutomation, formViews, isDirty, newAction, newTrigger, parseSaveError, pruneConditions, toCreate, toUpdate, triggerSummary, triggerTable, triggerUnavailableReason, webhookUrl, withCondition, withTriggerTable } from "./model";

const schema = makeSchema("creator");
schema.tables[0]!.fields = [
  { id: "fld1", table_id: "tbl1", name: "Name", type: "single_line_text", options: {} },
  { id: "fld2", table_id: "tbl1", name: "Qty", type: "number", options: { precision: 0, allow_negative: true } },
];
schema.tables[1]!.views.push(makeView({ id: "viw9", name: "Signup form", type: "form" }));

const filter = { conjunction: "and" as const, items: [{ field_id: "fld2", op: "gt" as const, value: 3 }] };

function automation(trigger: Trigger, actions: ActionStep[]): Automation {
  return { id: "aut1", base_id: "app1", name: "Flow", enabled: false, trigger, actions, next_run_at: null, webhook_token: null, created_by: "usr1", created_at: 1, updated_at: 2 };
}

describe("draft payloads", () => {
  it("round-trips every trigger and action type exactly", () => {
    const triggers: Trigger[] = [
      { type: "record_created", table_id: "tbl1" },
      { type: "record_updated", table_id: "tbl1", field_ids: ["fld1"] },
      { type: "record_matches", table_id: "tbl1", filter },
      { type: "form_submitted", view_id: "viw9" },
      { type: "schedule", cron: "0 9 * * 1", timezone: "Europe/Berlin" },
      { type: "webhook" },
    ];
    const actions: ActionStep[] = [
      { type: "create_record", table_id: "tbl2", values: { fld2: "{{trigger.record.fields.Name}}", fld1: 4 } },
      { type: "update_record", table_id: "tbl1", record_id: "{{steps.1.record_id}}", values: { fld1: "x" }, condition: filter },
      { type: "send_email", to: "a@example.com, b@example.com", subject: "Hi {{trigger.record.fields.Name}}", body: "Body" },
      { type: "http_request", method: "PUT", url: "https://example.com/{{trigger.record.id}}", headers: { Authorization: "Bearer x" }, body: "{\"a\":1}" },
      { type: "notify", user_ids: ["usr1", "usr2"], message: "done" },
    ];
    for (const trigger of triggers) {
      const draft = draftFromAutomation(automation(trigger, actions));
      expect(toUpdate(draft)).toEqual({ name: "Flow", trigger, actions });
      expect(toCreate(draft)).toEqual({ name: "Flow", trigger, actions });
    }
  });

  it("only sends enabled when creating an enabled automation", () => {
    const draft = draftFromAutomation(automation({ type: "webhook" }, []));
    expect(toCreate(draft)).not.toHaveProperty("enabled");
    expect(toCreate(draft, true)).toMatchObject({ enabled: true });
  });

  it("trims the name and drops empty conditions and empty request bodies", () => {
    const draft = draftFromAutomation(automation({ type: "webhook" }, [{ type: "http_request", method: "GET", url: "https://x.test", headers: {}, body: "", condition: null }]));
    draft.name = "  Spaced  ";
    expect(toUpdate(draft)).toEqual({ name: "Spaced", trigger: { type: "webhook" }, actions: [{ type: "http_request", method: "GET", url: "https://x.test", headers: {} }] });
  });

  it("does not share objects with the saved automation", () => {
    const saved = automation({ type: "record_updated", table_id: "tbl1", field_ids: ["fld1"] }, []);
    const draft = draftFromAutomation(saved);
    if (draft.trigger.type === "record_updated") draft.trigger.field_ids.push("fld2");
    expect((saved.trigger as { field_ids: string[] }).field_ids).toEqual(["fld1"]);
  });
});

describe("isDirty", () => {
  it("ignores key order and null conditions, notices real edits", () => {
    const saved = automation({ type: "webhook" }, [{ type: "create_record", table_id: "tbl2", values: { a: 1, b: 2 }, condition: null }]);
    const draft = draftFromAutomation(saved);
    expect(isDirty(draft, saved)).toBe(false);
    draft.steps[0]!.step = { type: "create_record", table_id: "tbl2", values: { b: 2, a: 1 } };
    expect(isDirty(draft, saved)).toBe(false);
    draft.steps[0]!.step = { type: "create_record", table_id: "tbl2", values: { b: 2, a: 5 } };
    expect(isDirty(draft, saved)).toBe(true);
    draft.name = "Other";
    expect(isDirty(draftFromAutomation({ ...saved, name: "Other" }), saved)).toBe(true);
  });

  it("canonicalJson sorts keys deeply", () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}');
  });
});

describe("new triggers and actions", () => {
  it("defaults each trigger type to the first sensible target", () => {
    expect(newTrigger("record_created", schema, "UTC")).toEqual({ type: "record_created", table_id: "tbl1" });
    expect(newTrigger("record_updated", schema, "UTC")).toEqual({ type: "record_updated", table_id: "tbl1", field_ids: [] });
    expect(newTrigger("record_matches", schema, "UTC")).toEqual({ type: "record_matches", table_id: "tbl1", filter: { conjunction: "and", items: [] } });
    expect(newTrigger("form_submitted", schema, "UTC")).toEqual({ type: "form_submitted", view_id: "viw9" });
    expect(newTrigger("schedule", schema, "Europe/Paris")).toEqual({ type: "schedule", cron: "0 9 * * *", timezone: "Europe/Paris" });
    expect(newTrigger("webhook", schema, "UTC")).toEqual({ type: "webhook" });
  });

  it("refuses a form trigger when the base has no form view", () => {
    const bare = makeSchema("creator");
    expect(newTrigger("form_submitted", bare, "UTC")).toBeNull();
    expect(triggerUnavailableReason("form_submitted", bare)).toBe("Create a form view first");
    expect(triggerUnavailableReason("form_submitted", schema)).toBeNull();
    expect(formViews(schema).map((f) => f.view.id)).toEqual(["viw9"]);
  });

  it("update_record starts from the trigger record only when the trigger has one", () => {
    expect(newAction("update_record", schema, { type: "record_created", table_id: "tbl2" })).toEqual({ type: "update_record", table_id: "tbl2", record_id: "{{trigger.record.id}}", values: {} });
    expect(newAction("update_record", schema, { type: "webhook" })).toMatchObject({ record_id: "" });
    expect(newAction("create_record", schema, { type: "form_submitted", view_id: "viw9" })).toMatchObject({ table_id: "tbl2" });
    expect(newAction("http_request", schema, { type: "webhook" })).toEqual({ type: "http_request", method: "POST", url: "", headers: {}, body: "" });
  });

  it("finds the table of form and record triggers", () => {
    expect(triggerTable({ type: "form_submitted", view_id: "viw9" }, schema)?.id).toBe("tbl2");
    expect(triggerTable({ type: "record_created", table_id: "tbl1" }, schema)?.id).toBe("tbl1");
    expect(triggerTable({ type: "webhook" }, schema)).toBeNull();
    expect(triggerTable({ type: "record_created", table_id: "gone" }, schema)).toBeNull();
  });

  it("changing the trigger table resets what depended on the old one", () => {
    expect(withTriggerTable({ type: "record_updated", table_id: "tbl1", field_ids: ["fld1"] }, "tbl2")).toEqual({ type: "record_updated", table_id: "tbl2", field_ids: [] });
    expect(withTriggerTable({ type: "record_matches", table_id: "tbl1", filter }, "tbl2")).toEqual({ type: "record_matches", table_id: "tbl2", filter: { conjunction: "and", items: [] } });
    expect(withTriggerTable({ type: "record_created", table_id: "tbl1" }, "tbl2")).toEqual({ type: "record_created", table_id: "tbl2" });
  });

  it("prunes conditions that name fields of another table", () => {
    const steps = [{ key: "a", step: withCondition({ type: "notify", user_ids: ["u"], message: "m" }, filter) }];
    const kept = pruneConditions(steps, schema.tables[0]!);
    expect(kept[0]!.step.condition).toEqual(filter);
    expect(pruneConditions(steps, schema.tables[1]!)[0]!.step.condition).toBeUndefined();
    expect(pruneConditions(steps, null)[0]!.step.condition).toBeUndefined();
    expect(actionsPayload(pruneConditions(steps, null))[0]).not.toHaveProperty("condition");
  });
});

describe("summaries", () => {
  it("describes triggers", () => {
    expect(triggerSummary({ type: "record_created", table_id: "tbl1" }, schema)).toBe("A record is created in Tasks");
    expect(triggerSummary({ type: "record_updated", table_id: "tbl1", field_ids: ["fld1", "fld2"] }, schema)).toBe("A record in Tasks is updated (Name, Qty)");
    expect(triggerSummary({ type: "record_matches", table_id: "tbl1", filter }, schema)).toBe("A record in Tasks matches conditions");
    expect(triggerSummary({ type: "form_submitted", view_id: "viw9" }, schema)).toBe('The form "Signup form" is submitted');
    expect(triggerSummary({ type: "schedule", cron: "0 9 * * 1", timezone: "UTC" }, schema)).toBe("Every Monday at 09:00 (UTC)");
    expect(triggerSummary({ type: "webhook" }, schema)).toBe("A webhook is called");
    expect(triggerSummary({ type: "record_created", table_id: "gone" }, schema)).toContain("deleted table");
  });

  it("describes actions", () => {
    expect(actionSummary({ type: "create_record", table_id: "tbl2", values: {} }, schema)).toBe("Create a record in People");
    expect(actionSummary({ type: "http_request", method: "POST", url: "https://api.example.com/x?y=1", headers: {} }, schema)).toBe("POST api.example.com");
    expect(actionSummary({ type: "http_request", method: "GET", url: "", headers: {} }, schema)).toBe("GET request");
    expect(actionSummary({ type: "notify", user_ids: ["a"], message: "m" }, schema)).toBe("Notify 1 person");
    expect(actionSummary({ type: "notify", user_ids: ["a", "b"], message: "m" }, schema)).toBe("Notify 2 people");
    expect(actionSummary({ type: "send_email", to: "", subject: "", body: "" }, schema)).toBe("Send an email");
  });
});

describe("parseSaveError", () => {
  it("splits 'action N: ' prefixes into a 0-based index", () => {
    expect(parseSaveError('action 2: field "Qty": not a number')).toEqual({ action: 1, text: 'field "Qty": not a number' });
    expect(parseSaveError("action 10: the URL is required")).toEqual({ action: 9, text: "the URL is required" });
  });

  it("leaves trigger and name errors unattached", () => {
    expect(parseSaveError("invalid cron expression \"x\"")).toEqual({ action: null, text: 'invalid cron expression "x"' });
  });
});

describe("webhookUrl", () => {
  it("joins origin and token", () => {
    expect(webhookUrl("ogh_abc", "https://grid.example.com/")).toBe("https://grid.example.com/api/hooks/ogh_abc");
  });
});
