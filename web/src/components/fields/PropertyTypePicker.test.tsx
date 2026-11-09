import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PropertyTypeList } from "./PropertyTypePicker";

describe("PropertyTypeList", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens at the chosen type, which is a third of the way down the list", () => {
    const scrolled: (string | null)[] = [];
    // jsdom has no layout and no scrollIntoView; record what the list asks to bring into view.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent);
    };
    render(<PropertyTypeList value="date" onChange={() => {}} />);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toMatch(/^Date/);
  });
});
