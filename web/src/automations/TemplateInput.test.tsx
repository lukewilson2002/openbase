import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Providers, createQueryClient } from "@/providers";
import { TemplateInput } from "./TemplateInput";
import type { TemplateContext } from "./templates";

const record: TemplateContext = { shape: "record", fields: [{ id: "fld1", name: "Name" }, { id: "fld2", name: "Qty" }], earlier: [{ type: "create_record", table_id: "tbl2", values: {} }] };

function Harness({ ctx, initial = "" }: { ctx: TemplateContext; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Providers client={createQueryClient()}>
      <TemplateInput value={value} onChange={setValue} ctx={ctx} label="Subject" />
    </Providers>
  );
}

const input = () => screen.getByRole("textbox", { name: "Subject" }) as HTMLInputElement;

describe("TemplateInput", () => {
  it("inserts a token at the caret and puts the caret after it", async () => {
    const user = userEvent.setup();
    render(<Harness ctx={record} initial="Hello !" />);
    input().focus();
    input().setSelectionRange(6, 6);
    fireEvent.select(input());
    await user.click(screen.getByRole("button", { name: "Insert data into Subject" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Name/ }));
    expect(input()).toHaveValue("Hello {{trigger.record.fields.Name}}!");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(input().selectionStart).toBe("Hello {{trigger.record.fields.Name}}".length);
  });

  it("replaces the selected text", async () => {
    const user = userEvent.setup();
    render(<Harness ctx={record} initial="Hi NAME!" />);
    input().focus();
    input().setSelectionRange(3, 7);
    fireEvent.select(input());
    await user.click(screen.getByRole("button", { name: "Insert data into Subject" }));
    await user.click(await screen.findByRole("menuitem", { name: /Record id/ }));
    expect(input()).toHaveValue("Hi {{trigger.record.id}}!");
  });

  it("appends when the input was never focused", async () => {
    const user = userEvent.setup();
    render(<Harness ctx={record} initial="Order " />);
    await user.click(screen.getByRole("button", { name: "Insert data into Subject" }));
    await user.click(await screen.findByRole("menuitem", { name: /Trigger time/ }));
    expect(input()).toHaveValue("Order {{trigger.time}}");
  });

  it("groups tokens by trigger, trigger record and earlier steps", async () => {
    const user = userEvent.setup();
    render(<Harness ctx={record} />);
    await user.click(screen.getByRole("button", { name: "Insert data into Subject" }));
    const menu = await screen.findByRole("menu", { name: "Insert data" });
    expect(within(menu).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Trigger", "Trigger record", "Step 1: Create record"]);
    await user.click(within(menu).getByRole("menuitem", { name: /record_id/ }));
    expect(input()).toHaveValue("{{steps.1.record_id}}");
  });

  it("lets you type a path into a webhook body", async () => {
    const user = userEvent.setup();
    render(<Harness ctx={{ shape: "webhook", fields: [], earlier: [] }} />);
    await user.click(screen.getByRole("button", { name: "Insert data into Subject" }));
    const menu = await screen.findByRole("menu", { name: "Insert data" });
    const insert = within(menu).getByRole("button", { name: "Insert" });
    expect(insert).toBeDisabled();
    await user.type(within(menu).getByLabelText(/Path in the JSON body/), "order.items.0.sku");
    await user.click(insert);
    expect(input()).toHaveValue("{{trigger.body.order.items.0.sku}}");
  });

  it("offers no record data for a schedule", async () => {
    const user = userEvent.setup();
    render(<Harness ctx={{ shape: "schedule", fields: [], earlier: [] }} />);
    await user.click(screen.getByRole("button", { name: "Insert data into Subject" }));
    const menu = await screen.findByRole("menu", { name: "Insert data" });
    expect(within(menu).queryByRole("menuitem", { name: /Record id/ })).not.toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
  });
});
