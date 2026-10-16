import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CellValue } from "../CellValue";
import { ALL_FIELDS } from "@/test/fields";
import { choiceClass } from "@/lib/colors";
import type { FormatCtx } from "@/lib/cells/format";

const names: Record<string, string> = { usr1: "Sam Rivera", usr2: "Alex Chen" };
const format: FormatCtx = {
  timeZone: "UTC",
  userName: (id) => names[id],
  userColor: (id) => ({ usr1: "teal", usr2: "orange" })[id],
};

describe("person chips", () => {
  it("tint each assignee in their own colour, so two people never look alike", () => {
    render(<CellValue field={ALL_FIELDS.user} value={["usr1", "usr2"]} format={format} emails={new Map([["usr1", "sam@example.com"], ["usr2", "alex@example.com"]])} />);
    const sam = screen.getByText("Sam Rivera").closest("[data-person-color]")!;
    const alex = screen.getByText("Alex Chen").closest("[data-person-color]")!;
    expect(sam).toHaveClass(...choiceClass("teal").split(" "));
    expect(alex).toHaveClass(...choiceClass("orange").split(" "));
    expect(sam.className).not.toBe(alex.className);
    // The face inside the chip matches the chip's hue.
    expect(sam.querySelector('[role="img"]')).toHaveClass("ob-hue-teal");
    expect(alex.querySelector('[role="img"]')).toHaveClass("ob-hue-orange");
  });
});
