import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Field } from "./input";
import { EntitySelect, type EntityOption } from "./entity-select";

const OPTIONS: EntityOption[] = [
  { value: "tbl1", label: "Orders", hue: "blue" },
  { value: "tbl2", label: "Contacts" },
  { value: "tbl3", label: "Shipments", hue: "orange" },
  { value: "tbl4", label: "Archive", hue: null, disabled: true },
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
  it("is labelled by its Field and shows the chosen option with its color mark", () => {
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Table" });
    expect(trigger).toHaveTextContent("Orders");
    expect(trigger.querySelector(".ob-mark.ob-hue-blue")).toBeInTheDocument();
    expect(trigger).toHaveAccessibleDescription("Pick one");
  });

  it("lists every option with its mark (a blank space for an option without one) and picks on click", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    await user.click(screen.getByRole("combobox", { name: "Table" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Orders", "Contacts", "Shipments", "Archive"]);
    expect(options[2]!.querySelector(".ob-mark.ob-hue-orange")).toBeInTheDocument();
    expect(options[1]!.querySelector(".ob-mark")).toBeNull();
    // No hue stored: the mark takes the colour its name hashes to, so it is never blank.
    expect(options[3]!.querySelector(".ob-mark")).toBeInTheDocument();
    // Marks never replace the name, and never carry it.
    expect(options[0]!.querySelector(".ob-mark")).toHaveAttribute("aria-hidden", "true");
    await user.click(options[2]!);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("tbl3");
    expect(screen.getByRole("combobox", { name: "Table" })).toHaveTextContent("Shipments");
    expect(screen.getByRole("combobox", { name: "Table" }).querySelector(".ob-mark.ob-hue-orange")).toBeInTheDocument();
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
