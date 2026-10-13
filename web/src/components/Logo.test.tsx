import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark, Logo } from "./Logo";

describe("Logo", () => {
  it("draws the lockup with an accessible name and a wordmark that follows the text colour", () => {
    const { container } = render(<Logo />);
    expect(screen.getByRole("img", { name: "OpenBase" })).toBeInTheDocument();
    const paths = [...container.querySelectorAll("path")];
    // The six cube faces keep their brand colours; the wordmark alone is currentColor.
    expect(paths.filter((p) => p.getAttribute("fill") === "currentColor")).toHaveLength(1);
    expect(paths.filter((p) => /^#[0-9A-F]{6}$/i.test(p.getAttribute("fill") ?? ""))).toHaveLength(6);
  });

  it("draws just the small mark without a name, hidden from assistive technology", () => {
    const { container } = render(<Logo showName={false} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.getAttribute("viewBox")).toBe("0 0 32 32");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("offers the master mark for larger sizes", () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 400 400");
  });
});
