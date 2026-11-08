import { describe, expect, it } from "vitest";
import type { Field } from "@/api/types";
import { defaultKind, type KindContext } from "@/components/fields/fieldKinds";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import { chipText, needsSetup, planProperty, probeField, valueFor, whyNoValue, type ValueCtx } from "./newProperty";

const table = makeTable([field("text", { multiline: false }, { id: "fld_name", name: "Name" })]);
const ctx: KindContext = { table, tables: [table] };
// Sunday, Nov 8 2026, noon in New York.
const NOW = Date.UTC(2026, 10, 8, 17, 0, 0);
const vctx: ValueCtx = { timeZone: "America/New_York", now: NOW, weekStart: 0 };

describe("planProperty", () => {
  it("takes the guess when nothing was chosen", () => {
    expect(planProperty("$600", null, ctx)).toEqual({ guessed: true, kind: { type: "currency", options: { precision: 2, symbol: "$", allow_negative: true } } });
    expect(planProperty("", null, ctx)).toEqual({ guessed: true, kind: { type: "text", options: { multiline: false } } });
  });

  it("takes the choice, keeping the guess's options when it chose the same type", () => {
    const same = planProperty("Nov 14 9am", "date", ctx);
    expect(same.guessed).toBe(false);
    expect(same.kind).toMatchObject({ type: "date", options: { include_time: true } });
    expect(planProperty("Nov 14", "text", ctx)).toEqual({ guessed: false, kind: { type: "text", options: { multiline: false } } });
  });

  it("keeps the decimals typed for a number-like type chosen by hand", () => {
    expect(planProperty("3.755", "number", ctx).kind).toMatchObject({ type: "number", options: { precision: 3 } });
    expect(planProperty("3", "currency", ctx).kind).toMatchObject({ type: "currency", options: { precision: 2 } });
    expect(planProperty("3.5555", "currency", ctx).kind).toMatchObject({ options: { precision: 4 } });
    expect(planProperty("0.5", "percent", ctx).kind).toMatchObject({ type: "percent", options: { precision: 1 } });
  });

  it("starts a select with the names typed, each its own colour", () => {
    const one = planProperty("Open", "single_select", ctx).kind;
    expect(one).toEqual({ type: "single_select", options: { choices: [{ id: "", name: "Open", color: expect.any(String) }] } });
    const many = planProperty('red, "blue, green", Red', "multiple_select", ctx).kind;
    const choices = (many.options as { choices: { name: string; color: string }[] }).choices;
    expect(choices.map((c) => c.name)).toEqual(["red", "blue, green"]);
    expect(new Set(choices.map((c) => c.color)).size).toBe(2);
    expect(planProperty("", "single_select", ctx).kind).toEqual({ type: "single_select", options: { choices: [] } });
  });
});

describe("chipText", () => {
  it("says where a guess came from, and when the type was chosen", () => {
    expect(chipText(planProperty("Nov 14", null, ctx), "Nov 14")).toBe("Date · Guessed from “Nov 14”");
    expect(chipText(planProperty("Nov 14", "text", ctx), "Nov 14")).toBe("Text · You chose this type");
  });
  it("is just the type when nothing is typed, and trims the value it quotes", () => {
    expect(chipText(planProperty("  ", null, ctx), "  ")).toBe("Text");
    expect(chipText(planProperty(" Harper ", null, ctx), " Harper ")).toBe("Text · Guessed from “Harper”");
  });
  it("shortens a long value", () => {
    const long = "Harper and Sons Incorporated and Daughters";
    expect(chipText(planProperty(long, null, ctx), long)).toBe("Text · Guessed from “Harper and Sons Incorpo…”");
  });
});

describe("types that need more than a name and a value", () => {
  it("are the ones a guess can never produce, which the dialog sets up", () => {
    for (const t of ["link", "formula", "lookup", "rollup", "count", "button"] as const) expect(needsSetup(t)).toBe(true);
    for (const t of ["text", "date", "single_select", "created_time", "attachment"] as const) expect(needsSetup(t)).toBe(false);
  });
  it("say why they take no typed value", () => {
    expect(whyNoValue("created_time")).toBe("Filled in by OpenBase");
    expect(whyNoValue("attachment")).toMatch(/once the property exists/);
    expect(whyNoValue("text")).toBeNull();
    expect(whyNoValue("single_select")).toBeNull();
  });
});

const made = (type: Parameters<typeof defaultKind>[0], over: Record<string, unknown> = {}): Field => {
  const kind = defaultKind(type, ctx);
  return { id: "fld_new", table_id: "tbl1", name: "New", ...kind, options: { ...(kind.options as object), ...over } } as Field;
};

describe("valueFor", () => {
  it("is nothing for blank text", () => {
    expect(valueFor(made("text"), "   ", vctx)).toEqual({ ok: true, value: null });
  });

  it("reads a date like capture does: the next such day, in the person's zone", () => {
    expect(valueFor(made("date"), "Nov 14", vctx)).toEqual({ ok: true, value: "2026-11-14" });
    expect(valueFor(made("date"), "tomorrow", vctx)).toEqual({ ok: true, value: "2026-11-09" });
    expect(valueFor(made("date"), "Friday", vctx)).toEqual({ ok: true, value: "2026-11-13" });
  });

  it("keeps the time of a date with a time as the instant it names in the person's zone", () => {
    expect(valueFor(made("date", { include_time: true }), "Nov 14 9am", vctx)).toEqual({ ok: true, value: "2026-11-14T14:00:00.000Z" });
  });

  it("falls back to the cell parser when the phrase does not fit the property's date options", () => {
    // A date property that holds a time reads a bare day through the parser, which stores midnight in the zone.
    expect(valueFor(made("date", { include_time: true }), "2026-11-14", vctx)).toMatchObject({ ok: true });
    expect(valueFor(made("date"), "not a date", vctx)).toMatchObject({ ok: false });
  });

  it("ticks a checkbox for a yes or a check mark, and leaves it clear for a no or a cross", () => {
    for (const yes of ["yes", "true", "✓", "✔"]) expect(valueFor(made("checkbox"), yes, vctx)).toEqual({ ok: true, value: true });
    for (const no of ["no", "false", "✗", "✘"]) expect(valueFor(made("checkbox"), no, vctx)).toEqual({ ok: true, value: null });
  });

  it("counts filled stars for a rating, and nothing for hollow ones", () => {
    const stars = made("rating");
    expect(valueFor(stars, "★★★", vctx)).toEqual({ ok: true, value: 3 });
    expect(valueFor(stars, "★★☆☆☆", vctx)).toEqual({ ok: true, value: 2 });
    expect(valueFor(stars, "☆☆☆", vctx)).toEqual({ ok: true, value: null });
    expect(valueFor(stars, "9", vctx)).toEqual({ ok: true, value: 5 });
  });

  it("parses everything else as a cell would be pasted", () => {
    expect(valueFor(made("currency"), "$600", vctx)).toEqual({ ok: true, value: 600 });
    expect(valueFor(made("number", { precision: 1 }), "1,250.5", vctx)).toEqual({ ok: true, value: 1250.5 });
    expect(valueFor(made("percent", { precision: 0 }), "15%", vctx)).toEqual({ ok: true, value: 0.15 });
    expect(valueFor(made("duration"), "1:30", vctx)).toEqual({ ok: true, value: 5400 });
    expect(valueFor(made("email"), "dana@harperco.example", vctx)).toEqual({ ok: true, value: "dana@harperco.example" });
    expect(valueFor(made("number"), "plenty", vctx)).toMatchObject({ ok: false });
  });

  it("is the same for the same text and moment (a pure function)", () => {
    const a = valueFor(made("date"), "next Friday", vctx);
    expect(valueFor(made("date"), "next Friday", vctx)).toEqual(a);
    expect(valueFor(made("date"), "next Friday", { ...vctx, now: NOW + 86_400_000 * 7 })).not.toEqual(a);
  });
});

describe("probeField", () => {
  it("stands in for the property so a value can be checked before it exists", () => {
    const probe = probeField(planProperty("", "number", ctx).kind);
    expect(probe.type).toBe("number");
    expect(valueFor(probe, "12", vctx)).toEqual({ ok: true, value: 12 });
    expect(valueFor(probe, "abc", vctx)).toMatchObject({ ok: false });
  });
  it("accepts every type", () => {
    for (const f of Object.values(ALL_FIELDS)) expect(probeField({ type: f.type, options: (f as { options: unknown }).options } as never).type).toBe(f.type);
  });
});
