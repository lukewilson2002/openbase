import { describe, expect, it } from "vitest";
import type { Action } from "@/api/types";
import { bodyToken, fieldToken, hasTemplate, insertToken, templateGroups } from "./templates";

const fields = [
  { id: "fldName", name: "Name" },
  { id: "fldDue", name: "Due date" },
];
const create: Action = { type: "create_record", table_id: "tbl2", values: {} };
const http: Action = { type: "http_request", method: "GET", url: "https://example.com", headers: {} };

describe("templateGroups", () => {
  it("offers record data, field names and earlier steps for a record trigger", () => {
    const groups = templateGroups({ shape: "record", fields, earlier: [create, http] });
    expect(groups.map((g) => g.id)).toEqual(["trigger", "record", "step-1", "step-2"]);
    const record = groups.find((g) => g.id === "record")!;
    expect(record.tokens.map((t) => t.token)).toEqual(["{{trigger.record.id}}", "{{trigger.record.table_id}}", "{{trigger.record.fields.Name}}", "{{trigger.record.fields.Due date}}"]);
    expect(groups.find((g) => g.id === "step-1")!.tokens.map((t) => t.token)).toEqual(["{{steps.1.record_id}}", "{{steps.1.table_id}}"]);
    expect(groups.find((g) => g.id === "step-2")!.tokens.map((t) => t.token)).toEqual(["{{steps.2.status}}", "{{steps.2.body}}", "{{steps.2.json}}"]);
    expect(groups.find((g) => g.id === "step-2")!.label).toBe("Step 2: HTTP request");
  });

  it("numbers steps from 1 and only lists steps before the action", () => {
    expect(templateGroups({ shape: "record", fields, earlier: [] }).some((g) => g.id.startsWith("step-"))).toBe(false);
  });

  it("offers the body path input for webhooks and no record data", () => {
    const groups = templateGroups({ shape: "webhook", fields: [], earlier: [] });
    expect(groups.map((g) => g.id)).toEqual(["trigger", "body"]);
    expect(groups[1]!.bodyPath).toBe(true);
  });

  it("schedules only have the trigger type and time", () => {
    const groups = templateGroups({ shape: "schedule", fields: [], earlier: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tokens.map((t) => t.token)).toEqual(["{{trigger.type}}", "{{trigger.time}}"]);
  });
});

describe("tokens", () => {
  it("uses the field id when the name would break the placeholder syntax", () => {
    expect(fieldToken({ id: "fld1", name: "a}}b" })).toBe("{{trigger.record.fields.fld1}}");
    expect(fieldToken({ id: "fld1", name: "  " })).toBe("{{trigger.record.fields.fld1}}");
  });

  it("builds body tokens from dotted paths and refuses empty ones", () => {
    expect(bodyToken("order. items.0.sku")).toBe("{{trigger.body.order.items.0.sku}}");
    expect(bodyToken(" . ")).toBeNull();
  });
});

describe("insertToken", () => {
  it("inserts at the caret", () => {
    expect(insertToken("Hello !", "{{trigger.record.id}}", 6, 6)).toEqual({ text: "Hello {{trigger.record.id}}!", caret: 6 + "{{trigger.record.id}}".length });
  });

  it("replaces the selection", () => {
    expect(insertToken("Hello WORLD!", "{{x}}", 6, 11)).toEqual({ text: "Hello {{x}}!", caret: 11 });
  });

  it("appends when there is no selection and clamps stale offsets", () => {
    expect(insertToken("abc", "{{x}}", null, null).text).toBe("abc{{x}}");
    expect(insertToken("abc", "{{x}}", 99, 120).text).toBe("abc{{x}}");
    expect(insertToken("abc", "{{x}}", -4, 1).text).toBe("{{x}}bc");
  });
});

describe("hasTemplate", () => {
  it("detects placeholders in strings only", () => {
    expect(hasTemplate("{{trigger.type}}")).toBe(true);
    expect(hasTemplate("plain")).toBe(false);
    expect(hasTemplate(12)).toBe(false);
    expect(hasTemplate(null)).toBe(false);
  });
});
