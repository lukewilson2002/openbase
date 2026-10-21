import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TableRecord } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { field } from "@/test/fields";
import { DescriptionHover } from "./description";

const notes = field("text", { multiline: true }, { id: "f_notes", name: "Notes" });
const brief = field("rich_text", {}, { id: "f_brief", name: "Brief" });
const record = (values: TableRecord["values"]): TableRecord => ({ id: "rec1", values, created_at: 0, updated_at: 0 }) as unknown as TableRecord;

/** A screen whose primary pointer can (or cannot) hover. */
function pointer(canHover: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: query === "(hover: hover)" ? canHover : false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("DescriptionHover", () => {
  it("shows the title and the whole description, line breaks kept, when pointed at", async () => {
    pointer(true);
    const user = userEvent.setup();
    render(
      <DescriptionHover field={notes} record={record({ f_notes: "First line\nSecond line" })} title="Halo CE" format={DEFAULT_CTX}>
        <p>excerpt</p>
      </DescriptionHover>,
    );
    await user.hover(screen.getByText("excerpt"));
    const card = await screen.findByText("First line\nSecond line", { normalizer: (s) => s }, { timeout: 2000 });
    expect(card.className).toContain("whitespace-pre-wrap");
    expect(document.querySelector("[data-description-hover]")).toHaveTextContent("Halo CE");
  });

  it("renders rich text as markdown", async () => {
    pointer(true);
    const user = userEvent.setup();
    render(
      <DescriptionHover field={brief} record={record({ f_brief: "Buy **milk**" })} title="Groceries" format={DEFAULT_CTX}>
        <p>excerpt</p>
      </DescriptionHover>,
    );
    await user.hover(screen.getByText("excerpt"));
    expect(await screen.findByText("milk", { selector: "strong" }, { timeout: 2000 })).toBeInTheDocument();
  });

  it("leaves the child alone on a touch screen and when there is no description", () => {
    pointer(false);
    const { container, rerender } = render(
      <DescriptionHover field={notes} record={record({ f_notes: "Text" })} title="T" format={DEFAULT_CTX}>
        <p>excerpt</p>
      </DescriptionHover>,
    );
    // No hover trigger: Radix's would cancel touchstart, stopping taps and scrolling.
    expect(container.querySelector("[data-state]")).toBeNull();
    pointer(true);
    rerender(
      <DescriptionHover field={notes} record={record({ f_notes: "   " })} title="T" format={DEFAULT_CTX}>
        <p>excerpt</p>
      </DescriptionHover>,
    );
    expect(container.querySelector("[data-state]")).toBeNull();
  });
});
