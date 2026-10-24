import { describe, expect, it } from "vitest";
import type { PublicFormField } from "@/api/types";
import { readPrefill } from "./prefill";

const f = (id: string, label: string, type: PublicFormField["type"], options: unknown = {}, extra: Partial<PublicFormField> = {}): PublicFormField => ({ id, label, type, options: options as PublicFormField["options"], required: false, help: null, ...extra });
const choices = [{ id: "c1", name: "Free", color: "gray" }, { id: "c2", name: "Pro plan", color: "blue" }];
const fields: PublicFormField[] = [
  f("fldName", "Customer name", "text", {}, { required: true }),
  f("fldPlan", "Plan", "single_select", { choices }),
  f("fldTags", "Interests", "multiple_select", { choices }),
  f("fldSize", "Team size", "number", { precision: 0, allow_negative: false }),
  f("fldWhen", "Start date", "date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }),
  f("fldOk", "Agree", "checkbox"),
  f("fldStars", "Rating", "rating", { max: 5 }),
  f("fldFiles", "Files", "attachment"),
  f("blk1", "", "text", {}, { block: "heading" }),
];

describe("prefilling a public form from its address", () => {
  it("names a field by its label (any case, + or %20 for spaces) or its id", () => {
    expect(readPrefill(fields, "?prefill_Customer+name=Acme").values).toEqual({ fldName: "Acme" });
    expect(readPrefill(fields, "?PREFILL_customer%20NAME=Acme").values).toEqual({ fldName: "Acme" });
    expect(readPrefill(fields, "?prefill_fldName=Acme").values).toEqual({ fldName: "Acme" });
    expect(readPrefill(fields, "?prefill_Nobody=x&prefill_=y&other=z").values).toEqual({});
  });

  it("turns each value into the input of its field and ignores one that does not fit", () => {
    const { values } = readPrefill(
      fields,
      "?prefill_Plan=pro%20plan&prefill_Interests=free,Pro plan,nope&prefill_Team size=12&prefill_Start date=2026-03-01&prefill_Agree=yes&prefill_Rating=4&prefill_Files=a.png",
    );
    expect(values).toEqual({ fldPlan: "c2", fldTags: ["c1", "c2"], fldSize: "12", fldWhen: "2026-03-01", fldOk: true, fldStars: 4 });
    expect(readPrefill(fields, "?prefill_Plan=Gold&prefill_Team size=lots&prefill_Start date=tomorrow&prefill_Agree=maybe&prefill_Rating=9").values).toEqual({});
    expect(readPrefill(fields, "?prefill_Interests=Free&prefill_Interests=Pro plan").values).toEqual({ fldTags: ["c1", "c2"] });
  });

  it("never prefills a heading or paragraph", () => {
    expect(readPrefill(fields, "?prefill_blk1=x&hide_blk1=true")).toEqual({ values: {}, hidden: new Set() });
  });

  it("hides fields, but not a required one that would stay empty", () => {
    expect(readPrefill(fields, "?hide_Plan=true&hide_Team size&hide_Agree=no").hidden).toEqual(new Set(["fldPlan", "fldSize"]));
    expect(readPrefill(fields, "?hide_Customer name=true").hidden).toEqual(new Set());
    expect(readPrefill(fields, "?hide_Customer name=true&prefill_Customer name=Acme")).toEqual({ values: { fldName: "Acme" }, hidden: new Set(["fldName"]) });
    const withDefault = fields.map((x) => (x.id === "fldName" ? { ...x, default: "Someone" } : x));
    expect(readPrefill(withDefault, "?hide_Customer name=true").hidden).toEqual(new Set(["fldName"]));
  });
});
