import { describe, expect, it } from "vitest";
import { formatDuration, isActive, prettyJson, runDuration, stepTitle, triggerInfo, triggerName } from "./runs";

describe("formatDuration", () => {
  it("scales from milliseconds to minutes", () => {
    expect(formatDuration(340)).toBe("340 ms");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(25_400)).toBe("25 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(120_000)).toBe("2 min");
    expect(formatDuration(-1)).toBe("");
  });
});

describe("runDuration", () => {
  it("measures from the first attempt and is null while running", () => {
    expect(runDuration({ created_at: 1000, started_at: 1500, finished_at: 2500 })).toBe(1000);
    expect(runDuration({ created_at: 1000, started_at: null, finished_at: 2500 })).toBe(1500);
    expect(runDuration({ created_at: 1000, started_at: 1500, finished_at: null })).toBeNull();
    expect(runDuration({ created_at: 1000, started_at: 3000, finished_at: 2500 })).toBe(0);
  });

  it("knows which statuses are still moving", () => {
    expect(isActive("queued")).toBe(true);
    expect(isActive("running")).toBe(true);
    expect(isActive("succeeded")).toBe(false);
    expect(isActive("failed")).toBe(false);
  });
});

describe("triggerInfo", () => {
  it("reads the type, record id, body and test flag", () => {
    expect(triggerInfo({ type: "record_created", time: "t", record: { id: "rec1", table_id: "tbl1", fields: {} } })).toEqual({ type: "record_created", test: false, recordId: "rec1", hasBody: false });
    expect(triggerInfo({ type: "webhook", body: { a: 1 }, test: true })).toEqual({ type: "webhook", test: true, recordId: null, hasBody: true });
  });

  it("copes with unexpected shapes", () => {
    expect(triggerInfo(null)).toEqual({ type: "unknown", test: false, recordId: null, hasBody: false });
    expect(triggerInfo([1])).toEqual({ type: "unknown", test: false, recordId: null, hasBody: false });
  });

  it("names trigger types", () => {
    expect(triggerName("form_submitted")).toBe("Form submitted");
    expect(triggerName("mystery")).toBe("mystery");
  });
});

describe("stepTitle / prettyJson", () => {
  it("numbers steps from 1 and leaves system lines unnumbered", () => {
    expect(stepTitle({ index: 0, action: "create_record" })).toBe("Step 1: create record");
    expect(stepTitle({ index: null, action: "recovery" })).toBe("recovery");
    expect(stepTitle({ action: "recovery" })).toBe("recovery");
  });

  it("pretty prints JSON", () => {
    expect(prettyJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
  });
});
