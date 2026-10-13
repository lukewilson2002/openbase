import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Field } from "./input";
import { EntitySelect, type EntityOption } from "./entity-select";

const OPTIONS: EntityOption[] = [
  { value: "tbl1", label: "Orders", icon: "package" },
  { value: "tbl2", label: "Contacts" },
  { value: "tbl3", label: "Shipments", icon: "truck" },
  { value: "tbl4", label: "Archive", icon: "folder", disabled: true },
];

function Harness({ onValueChange = () => {} }: { onValueChange?: (v: string) => void }) {
  const [value, setValue] = useState("tbl1");
  return (
    <Field label="Table" hint="Pick one">
      {(ctl) => (
        <EntitySelect
          {...ctl}
          value={value}
          onValueChange={(v) => {
            setValue(v);
            onValueChange(v);
          }}
          options={OPTIONS}
        />
      )}
    </Field>
  );
}

describe("EntitySelect", () => {
  it("is labelled by its Field and shows the chosen option with its icon", () => {
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Table" });
    expect(trigger).toHaveTextContent("Orders");
    expect(trigger.querySelector("svg.lucide-package")).toBeInTheDocument();
    expect(trigger).toHaveAccessibleDescription("Pick one");
  });

  it("lists every option with its icon (none for an option without one) and picks on click", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    await user.click(screen.getByRole("combobox", { name: "Table" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Orders", "Contacts", "Shipments", "Archive"]);
    expect(options[2]!.querySelector("svg.lucide-truck")).toBeInTheDocument();
    expect(options[1]!.querySelector("svg")).toBeNull();
    await user.click(options[2]!);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("tbl3");
    expect(screen.getByRole("combobox", { name: "Table" })).toHaveTextContent("Shipments");
    expect(screen.getByRole("combobox", { name: "Table" }).querySelector("svg.lucide-truck")).toBeInTheDocument();
  });

  it("works from the keyboard and skips disabled options", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    screen.getByRole("combobox", { name: "Table" }).focus();
    await user.keyboard("{Enter}");
    await screen.findAllByRole("option");
    expect(screen.getByRole("option", { name: "Archive" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("tbl3");
  });

  it("can be disabled", () => {
    render(<EntitySelect value="tbl1" onValueChange={() => {}} options={OPTIONS} disabled aria-label="Linked table" />);
    expect(screen.getByRole("combobox", { name: "Linked table" })).toBeDisabled();
  });
});
