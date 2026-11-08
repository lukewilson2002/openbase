import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { CARD_PROPERTY_LIMIT, CardProperties, cardProperties } from "./CardProperties";

const status = ALL_FIELDS.single_select!;
const due = ALL_FIELDS.date!;
const amount = ALL_FIELDS.currency!;
const note = ALL_FIELDS.email!;
const rec = (values: Record<string, unknown>) => makeRecord(values);

describe("cardProperties", () => {
  it("takes the first three properties that have a value, in the view's order", () => {
    const record = rec({ [status.id]: "chs1", [due.id]: null, [amount.id]: 600, [note.id]: "a@b.co", [ALL_FIELDS.url!.id]: "https://x.test" });
    const fields = [status, due, amount, note, ALL_FIELDS.url!];
    expect(CARD_PROPERTY_LIMIT).toBe(3);
    expect(cardProperties(fields, record, DEFAULT_CTX).map((f) => f.id)).toEqual([status.id, amount.id, note.id]);
    expect(cardProperties(fields, record, DEFAULT_CTX, 4).map((f) => f.id)).toEqual([status.id, amount.id, note.id, ALL_FIELDS.url!.id]);
  });
});

describe("CardProperties", () => {
  it("shows a choice as a status chip, and puts a number at the right end in tabular figures", () => {
    const record = rec({ [status.id]: "chs2", [amount.id]: 1250 });
    const { container } = render(<CardProperties fields={[status, amount]} record={record} format={DEFAULT_CTX} emails={new Map()} />);
    const line = container.querySelector("[data-card-properties]")!;
    expect(within(line as HTMLElement).getByText("In progress").closest(".choice")).toHaveClass("choice-blue", "rounded-pill");
    const money = screen.getByTitle(amount.name);
    expect(money).toHaveClass("num", "ml-auto");
    expect(money).toHaveTextContent("$1,250.00");
    expect(screen.getByTitle(status.name)).not.toHaveClass("ml-auto");
  });

  it("draws nothing without properties", () => {
    const { container } = render(<CardProperties fields={[]} record={rec({})} format={DEFAULT_CTX} emails={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
