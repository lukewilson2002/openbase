import { describe, expect, it } from "vitest";
import type { Field } from "@/api/types";
import { makeView } from "@/test/utils";
import { withLayoutDefaults } from "./layoutDefaults";

const field = (id: string, type: string, options: Record<string, unknown> = {}) => ({ id, name: id, type, options }) as unknown as Field;
const config = makeView({ id: "viw1" }).config;

describe("withLayoutDefaults", () => {
  const text = field("fldName", "text");
  const status = field("fldStatus", "single_select");
  const owner = field("fldOwner", "user", { multiple: false });
  const due = field("fldDue", "date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null });

  it("stacks a board by a single select, before a person or a checkbox", () => {
    const next = withLayoutDefaults(config, "kanban", [text, owner, status]);
    expect(next.kanban.stack_field_id).toBe("fldStatus");
    expect(next.kanban.stack_order).toEqual([]);
  });

  it("places a calendar by a date", () => {
    expect(withLayoutDefaults(config, "calendar", [text, status, due]).calendar.date_field_id).toBe("fldDue");
  });

  it("leaves a setting that was already made, and one whose property is gone is made again", () => {
    const chosen = { ...config, kanban: { ...config.kanban, stack_field_id: "fldOwner" } };
    expect(withLayoutDefaults(chosen, "kanban", [status, owner])).toBe(chosen);
    expect(withLayoutDefaults(chosen, "kanban", [status]).kanban.stack_field_id).toBe("fldStatus");
  });

  it("keeps the layout's setup screen when no property fits, and does nothing for the other layouts", () => {
    expect(withLayoutDefaults(config, "kanban", [text, due])).toBe(config);
    expect(withLayoutDefaults(config, "calendar", [text, status])).toBe(config);
    for (const type of ["grid", "gallery", "list", "timeline", "form"] as const) expect(withLayoutDefaults(config, type, [text, status, due])).toBe(config);
  });
});
