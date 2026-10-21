import { describe, expect, it } from "vitest";
import type { PublicField, PublicRecord } from "@/api/types";
import { chipItems, displayText } from "@/lib/cells/format";
import { normalizeValue, sharedFields, toRecord } from "./publicFields";

const pf = (id: string, type: PublicField["type"], options: unknown = {}): PublicField => ({ id, name: id.toUpperCase(), type, options: options as PublicField["options"], description: null });

describe("public values for the shared display helpers", () => {
  it("turns user cells into names and created-by cells into one name", () => {
    expect(normalizeValue({ type: "user" }, [{ name: "Ada Lovelace" }, { name: "Grace Hopper" }])).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(normalizeValue({ type: "user" }, [])).toBeNull();
    expect(normalizeValue({ type: "created_by" }, { name: "Ada" })).toBe("Ada");
    expect(normalizeValue({ type: "last_modified_by" }, undefined)).toBeNull();
  });

  it("leaves every other value alone", () => {
    expect(normalizeValue({ type: "number" }, 3)).toBe(3);
    expect(normalizeValue({ type: "link" }, [{ id: "rec1", name: "Alpha" }])).toEqual([{ id: "rec1", name: "Alpha" }]);
    expect(normalizeValue({ type: "text" }, undefined)).toBeNull();
  });

  it("shows people by name in the shared chip code", () => {
    const fields = sharedFields({ fields: [pf("owner", "user", { multiple: true, notify: false })] });
    const record = toRecord({ id: "r1", values: { owner: [{ name: "Ada Lovelace" }] } } as PublicRecord, fields);
    const owner = fields.byId.get("owner")!;
    expect(chipItems(owner, record.values["owner"], { timeZone: "UTC", userName: () => undefined }).map((c) => c.text)).toEqual(["Ada Lovelace"]);
    expect(displayText(owner, record.values["owner"])).toBe("Ada Lovelace");
  });

  it("keeps the view's field order and takes the first field as the title", () => {
    const fields = sharedFields({ fields: [pf("b", "text"), pf("a", "number", { precision: 0, allow_negative: true })] });
    expect(fields.list.map((f) => f.id)).toEqual(["b", "a"]);
    expect(fields.title?.id).toBe("b");
    expect(fields.byId.get("a")?.type).toBe("number");
  });

  it("wraps a record with normalised values", () => {
    const fields = sharedFields({ fields: [pf("created", "created_by"), pf("n", "text")] });
    const rec = toRecord({ id: "rec1", values: { created: { name: "Ada" }, n: "x", stale: 1 } } as PublicRecord, fields);
    expect(rec).toMatchObject({ id: "rec1", values: { created: "Ada", n: "x", stale: 1 } });
  });
});
