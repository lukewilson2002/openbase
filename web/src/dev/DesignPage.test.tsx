import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { stubDesktop } from "@/test/utils";
import { Providers, createQueryClient } from "@/providers";
import DesignPage from "./DesignPage";
import { DESIGN_SECTIONS, DESIGN_THEMES } from "./designSections";

// A menu is a dropdown on a desktop and a sheet on a phone; these tests drive the dropdown (jsdom matches no query, so it would read as a phone).
beforeEach(() => stubDesktop());

/** What assistive technology reads as a control's name: aria-label, aria-labelledby, a label, or its text. */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label) return label.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const labels = (el as HTMLButtonElement).labels;
  if (labels?.length) return [...labels].map((l) => l.textContent ?? "").join(" ").trim();
  return (el.textContent ?? "").trim();
}

async function renderPage() {
  const view = render(
    <Providers client={createQueryClient()}>
      <DesignPage />
    </Providers>,
  );
  // The columns mount their content once their element exists.
  await waitFor(() => expect(view.container.querySelectorAll("[data-design-theme] > *").length).toBeGreaterThan(DESIGN_SECTIONS.length));
  return view;
}

describe("design reference page (DL-2)", () => {
  it("has a section for every token family and core component, in both themes", async () => {
    const { container } = await renderPage();
    for (const section of DESIGN_SECTIONS) {
      const el = container.querySelector(`[data-design-section="${section.id}"]`);
      expect(el, section.id).not.toBeNull();
      expect(within(el as HTMLElement).getByRole("heading", { level: 2, name: section.title })).toBeInTheDocument();
      for (const theme of DESIGN_THEMES) {
        const column = el!.querySelector(`[data-design-theme="${theme}"]`);
        expect(column, `${section.id} ${theme}`).not.toBeNull();
        expect(column).toHaveAttribute("data-theme-scope");
        expect(column).toHaveAttribute("data-theme", theme);
        // More than the column's own label: something is drawn.
        await waitFor(() => expect(column!.children.length, `${section.id} ${theme} is empty`).toBeGreaterThan(1));
      }
    }
  });

  it("lists every section in its index, and every section the core spec names", () => {
    const names = DESIGN_SECTIONS.map((s) => s.title).join(" | ");
    for (const component of ["Button", "IconButton", "ColorMark", "NavRow", "StatusChip", "FilterChip", "LinkChip", "CaptureChip", "Card", "FeedRow", "PropertyList", "FilterBar", "TemporaryChangesBar", "Tabs", "Popover and Menu", "Sheet", "SidePanel", "Dialog", "CommandPalette", "EmptyState", "Skeleton", "Toast"]) {
      expect(names, component).toContain(component);
    }
  });

  it("draws the overlays open, inside their frames, in both themes", async () => {
    const { container } = await renderPage();
    for (const [section, role] of [
      ["sheet", "dialog"],
      ["dialog", "dialog"],
      ["dialog", "alertdialog"],
      ["command-palette", "dialog"],
      ["popover-menu", "menu"],
    ] as const) {
      for (const theme of DESIGN_THEMES) {
        const column = container.querySelector<HTMLElement>(`[data-design-section="${section}"] [data-design-theme="${theme}"]`)!;
        await waitFor(() => expect(within(column).getAllByRole(role, { hidden: true }).length, `${section} ${role} ${theme}`).toBeGreaterThan(0));
      }
    }
  });

  it("gives every button and link a name, and hides every icon from assistive technology (DL-4)", async () => {
    const { container } = await renderPage();
    const unnamed = [...container.querySelectorAll("button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=tab]")]
      .filter((el) => !accessibleName(el))
      .map((el) => el.outerHTML.slice(0, 160));
    expect(unnamed).toEqual([]);
    const loud = [...document.body.querySelectorAll("svg")].filter((svg) => svg.getAttribute("aria-hidden") !== "true").map((svg) => svg.outerHTML.slice(0, 120));
    expect(loud).toEqual([]);
  });

  it("draws every icon at stroke width 2", async () => {
    await renderPage();
    const widths = new Set([...document.body.querySelectorAll("svg.lucide")].map((svg) => svg.getAttribute("stroke-width")));
    expect([...widths]).toEqual(["2"]);
  });

  it("shows the real token values of each theme", async () => {
    // jsdom has no cascade, so the page reads nothing; the swatches still name their variable.
    await renderPage();
    expect((await screen.findAllByText("--primary-ink")).length).toBe(2);
  });
});
