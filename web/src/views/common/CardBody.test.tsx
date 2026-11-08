import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { CardBody } from "./CardBody";

const title = ALL_FIELDS.text!;

function body(titleInset?: boolean) {
  return render(
    <CardBody record={makeRecord({ [title.id]: "Oakline Cycles" })} primary={title} fields={[]} format={DEFAULT_CTX} emails={new Map()} titleInset={titleInset} />,
  );
}

describe("CardBody's title", () => {
  it("leaves room for a select box in the card's corner, so the box never covers a letter", () => {
    body(true);
    expect(screen.getByRole("heading", { name: "Oakline Cycles" })).toHaveClass("pr-5", "pointer-coarse:pr-6");
  });

  it("uses the whole width when the card has no select box", () => {
    body();
    expect(screen.getByRole("heading", { name: "Oakline Cycles" }).className).not.toMatch(/\bpr-/);
  });
});
