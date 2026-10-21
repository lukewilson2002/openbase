import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CHOICES, field, makeRecord } from "@/test/fields";
import { DEFAULT_CTX as testFormat } from "@/lib/cells/format";
import { CellValue } from "./CellValue";
import { RecordSummary, summaryParts } from "./RecordSummary";

const notes = field("rich_text", {}, { id: "fld_notes", name: "Notes" });
const plain = field("text", { multiline: false }, { id: "fld_code", name: "Code" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const tags = field("multiple_select", { choices: CHOICES }, { id: "fld_tags", name: "Tags" });
const budget = field("number", { precision: 0 } as never, { id: "fld_budget", name: "Budget" });
const fields = [plain, notes, budget, status, tags];

describe("summaryParts", () => {
  it("describes a record by its first filled text field and lists its labels, nothing else beside them", () => {
    const r = makeRecord({ fld_code: "", fld_notes: "**Ship** the\n\nfirst cut", fld_budget: 4000, fld_status: "chs2", fld_tags: ["chs1"] });
    const parts = summaryParts(fields, r, testFormat);
    expect(parts.description).toBe("Ship the first cut");
    expect(parts.details.map((f) => f.name)).toEqual(["Status", "Tags"]);
  });

  it("shows a couple of other fields when a record has no labels, and a few more when detailed", () => {
    const r = makeRecord({ fld_code: "A-1", fld_budget: 4000 });
    // A one-line text field is a description too when nothing longer is filled.
    expect(summaryParts(fields, r, testFormat).description).toBe("A-1");
    expect(summaryParts(fields, r, testFormat).details.map((f) => f.name)).toEqual(["Budget"]);
    const labelled = makeRecord({ fld_budget: 4000, fld_status: "chs1" });
    expect(summaryParts(fields, labelled, testFormat).details.map((f) => f.name)).toEqual(["Status"]);
    expect(summaryParts(fields, labelled, testFormat, { detailed: true }).details.map((f) => f.name)).toEqual(["Status", "Budget"]);
  });

  it("uses the view's description field when it has one", () => {
    const r = makeRecord({ fld_code: "A-1", fld_notes: "Long story" });
    expect(summaryParts(fields, r, testFormat, { descriptionField: plain }).description).toBe("A-1");
  });
});

describe("RecordSummary", () => {
  it("draws the title, one line of description and the labels", () => {
    const r = makeRecord({ fld_notes: "Ship the first cut", fld_status: "chs2" });
    render(<RecordSummary title={<span>Launch</span>} record={r} fields={fields} format={testFormat} />);
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("Ship the first cut")).toHaveClass("line-clamp-1");
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });
});

describe("RecordSummary's other fields", () => {
  it("names each one before its value, on its own line; labels need no name", () => {
    const r = makeRecord({ fld_budget: 4000 });
    render(<RecordSummary title={<span>Launch</span>} record={r} fields={fields} format={testFormat} />);
    const line = screen.getByText("Budget").parentElement!;
    expect(line).toHaveTextContent(/^Budget4000$/);
    const labelled = makeRecord({ fld_status: "chs2" });
    render(<RecordSummary title={<span>Ship</span>} record={labelled} fields={fields} format={testFormat} />);
    expect(screen.queryByText("Status")).toBeNull();
  });
});

describe("a link field among other values", () => {
  it("is the first few records as chips, then \"+N more\", which shows them all and folds them again", async () => {
    const link = field("link", { linked_table_id: "tbl2", inverse_field_id: null, single: false } as never, { id: "fld_link", name: "Tasks" });
    const value = ["One", "Two", "Three", "Four", "Five"].map((name, i) => ({ id: `rec${i}`, name }));
    const { container } = render(<CellValue field={link} value={value} format={testFormat} className="truncate text-xs" />);
    const chips = () => Array.from(container.querySelectorAll("span.border-line")).map((c) => c.textContent);
    expect(chips()).toEqual(["One", "Two", "Three"]);
    await userEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(chips()).toEqual(["One", "Two", "Three", "Four", "Five"]);
    await userEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(chips()).toEqual(["One", "Two", "Three"]);
    expect(within(container).queryByRole("button", { name: "Show less" })).toBeNull();
  });
});
