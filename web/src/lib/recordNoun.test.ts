import { describe, expect, it } from "vitest";
import { pluralize, recordNoun, recordNounFor } from "./recordNoun";

describe("pluralize", () => {
  it.each([
    ["client", "clients"],
    ["company", "companies"],
    ["day", "days"],
    ["box", "boxes"],
    ["address", "addresses"],
    ["batch", "batches"],
    ["Wish", "Wishes"],
  ])("%s is %s", (one, many) => expect(pluralize(one)).toBe(many));
});

describe("recordNoun", () => {
  it("is the record name the creator set, else 'record'", () => {
    expect(recordNoun({ record_noun: "client" })).toBe("client");
    expect(recordNoun({ record_noun: "  client  " })).toBe("client");
    expect(recordNoun({ record_noun: "" })).toBe("record");
    expect(recordNoun({})).toBe("record");
  });

  it("is plural for any count but one", () => {
    expect(recordNounFor({ record_noun: "client" }, 12)).toBe("clients");
    expect(recordNounFor({ record_noun: "client" }, 0)).toBe("clients");
    expect(recordNounFor({ record_noun: "client" }, 1)).toBe("client");
    expect(recordNounFor({ record_noun: "" }, 3)).toBe("records");
  });
});
