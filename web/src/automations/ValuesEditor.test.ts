import { describe, expect, it } from "vitest";
import { ALL_FIELDS } from "@/test/fields";
import { automationSchema } from "./testUtils";
import { emptyValue, templateText, valueMode, writableFields } from "./ValuesEditor";

describe("writableFields", () => {
  it("leaves out computed fields and attachments", () => {
    const table = automationSchema().tables[0]!;
    expect(writableFields(table).map((f) => f.name)).toEqual(["Name", "Qty", "Status", "Done"]);
    expect(writableFields({ ...table, fields: [ALL_FIELDS.attachment, ALL_FIELDS.created_time, ALL_FIELDS.link, ALL_FIELDS.user] }).map((f) => f.type)).toEqual(["link", "user"]);
    expect(writableFields(undefined)).toEqual([]);
  });
});

describe("valueMode", () => {
  it("text-like fields and links are templates, numbers and checkboxes are typed", () => {
    expect(valueMode(ALL_FIELDS.text, "x")).toBe("template");
    expect(valueMode(ALL_FIELDS.rich_text, "")).toBe("template");
    expect(valueMode(ALL_FIELDS.email, null)).toBe("template");
    expect(valueMode(ALL_FIELDS.link, [])).toBe("template");
    expect(valueMode(ALL_FIELDS.number, 4)).toBe("value");
    expect(valueMode(ALL_FIELDS.checkbox, true)).toBe("value");
    expect(valueMode(ALL_FIELDS.date, null)).toBe("value");
    expect(valueMode(ALL_FIELDS.user, ["usr1"])).toBe("value");
  });

  it("a placeholder always makes it a template", () => {
    expect(valueMode(ALL_FIELDS.number, "{{trigger.body.qty}}")).toBe("template");
    expect(valueMode(ALL_FIELDS.date, "{{trigger.time}}")).toBe("template");
  });

  it("selects are typed only for choice ids; a name (typecast) or an unknown value opens as text", () => {
    expect(valueMode(ALL_FIELDS.single_select, "chs1")).toBe("value");
    expect(valueMode(ALL_FIELDS.single_select, null)).toBe("value");
    expect(valueMode(ALL_FIELDS.single_select, "Todo")).toBe("template");
    expect(valueMode(ALL_FIELDS.multiple_select, ["chs1", "chs2"])).toBe("value");
    expect(valueMode(ALL_FIELDS.multiple_select, ["chs1", "Brand new"])).toBe("template");
  });
});

describe("emptyValue / templateText", () => {
  it("starts text-like fields and links as empty text, everything else as null", () => {
    expect(emptyValue(ALL_FIELDS.text)).toBe("");
    expect(emptyValue(ALL_FIELDS.link)).toBe("");
    expect(emptyValue(ALL_FIELDS.number)).toBeNull();
    expect(emptyValue(ALL_FIELDS.checkbox)).toBeNull();
  });

  it("shows any stored value as text when switching to the template editor", () => {
    expect(templateText("a")).toBe("a");
    expect(templateText(null)).toBe("");
    expect(templateText(12)).toBe("12");
    expect(templateText(true)).toBe("true");
    expect(templateText(["a", "b"])).toBe('["a","b"]');
  });
});
