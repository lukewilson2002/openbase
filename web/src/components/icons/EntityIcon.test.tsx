import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityIcon, EntityLabel, EntityTile, WorkspaceTile, entityLetter } from "./EntityIcon";
import { peekFullIconSet, resetIconRegistryForTests } from "./registry";
import { fakeIconSet, gatedImporter } from "./testSet";

beforeEach(() => resetIconRegistryForTests());
afterEach(() => resetIconRegistryForTests());

describe("entityLetter", () => {
  it("is the first letter, upper-cased, or ? for a blank name", () => {
    expect(entityLetter("  crm ")).toBe("C");
    expect(entityLetter("")).toBe("?");
    expect(entityLetter(null)).toBe("?");
  });
});

describe("EntityIcon", () => {
  it("draws a popular icon at once and never loads the full set for it", () => {
    const gate = gatedImporter();
    resetIconRegistryForTests(gate.importer);
    const { container } = render(<EntityIcon name="truck" fallbackLetter="T" />);
    expect(container.querySelector("svg.lucide-truck")).toBeInTheDocument();
    expect(screen.queryByText("T")).not.toBeInTheDocument();
    expect(gate.calls.count).toBe(0);
    expect(peekFullIconSet()).toBeNull();
  });

  it("shows the letter while an other icon loads, then the icon, and keeps it cached", async () => {
    const gate = gatedImporter();
    resetIconRegistryForTests(gate.importer);
    const { container, rerender } = render(<EntityIcon name="anchor" fallbackLetter="A" />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
    await waitFor(() => expect(gate.calls.count).toBe(1));
    await act(async () => gate.release());
    await waitFor(() => expect(container.querySelector("svg")).toBeInTheDocument());
    expect(screen.queryByText("A")).not.toBeInTheDocument();

    // a second icon uses the cached set: no second load
    rerender(<EntityIcon name="zap" fallbackLetter="Z" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(gate.calls.count).toBe(1);
  });

  it("asks for the set once however many icons need it", async () => {
    const gate = gatedImporter();
    resetIconRegistryForTests(gate.importer);
    render(
      <>
        <EntityIcon name="anchor" fallbackLetter="A" />
        <EntityIcon name="zap" fallbackLetter="Z" />
        <EntityIcon name="umbrella" fallbackLetter="U" />
      </>,
    );
    await waitFor(() => expect(gate.calls.count).toBe(1));
    await act(async () => gate.release());
    await waitFor(() => expect(document.querySelectorAll("svg")).toHaveLength(3));
    expect(gate.calls.count).toBe(1);
  });

  it("falls back to the letter for a name the set does not have, and for no name", async () => {
    const gate = gatedImporter(fakeIconSet(1));
    resetIconRegistryForTests(gate.importer);
    const { container } = render(
      <>
        <EntityIcon name="no-such-icon" fallbackLetter="N" />
        <EntityIcon fallbackLetter="X" />
        <EntityIcon name={null} />
      </>,
    );
    await act(async () => gate.release());
    await waitFor(() => expect(peekFullIconSet()).not.toBeNull());
    expect(screen.getByText("N")).toBeInTheDocument();
    expect(screen.getByText("X")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  it("keeps the letter, without crashing, when the full set cannot be loaded", async () => {
    resetIconRegistryForTests(() => Promise.reject(new Error("offline")));
    const { container } = render(<EntityIcon name="anchor" fallbackLetter="A" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  it("renders nothing for a missing icon when there is no fallback", () => {
    const { container } = render(<EntityIcon name={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("EntityTile", () => {
  it("shows the icon when there is one and the generic base icon otherwise, in the base colour", () => {
    const { container, rerender } = render(<EntityTile name="Sales" icon="store" color="green_dark" size="lg" />);
    const tile = container.querySelector("[data-entity-tile]")!;
    expect(tile.querySelector("svg.lucide-store")).toBeInTheDocument();
    expect(tile).toHaveClass("ob-hue-green", "ob-tint");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    rerender(<EntityTile name="Sales" color="green_dark" size="lg" />);
    expect(container.querySelector("[data-entity-tile] svg.lucide-database")).toBeInTheDocument();
    // Without a colour (an entity that is neither a base nor a workspace) the letter stays.
    rerender(<EntityTile name="Sales" size="lg" />);
    expect(container.querySelector("[data-entity-tile]")).toHaveTextContent("S");
  });

  it("is solid with a white initial for a workspace, in its colour or one picked from its name", () => {
    const { container, rerender } = render(<WorkspaceTile ws={{ name: "Household", color: "green" }} />);
    expect(container.querySelector("[data-entity-tile]")).toHaveClass("ob-hue-green", "ob-solid");
    expect(container.querySelector("[data-entity-tile]")).toHaveTextContent("H");
    rerender(<WorkspaceTile ws={{ name: "Household" }} />);
    expect(container.querySelector("[data-entity-tile]")).toHaveClass("ob-solid");
  });

  it("is neutral without a colour", () => {
    const { container } = render(<EntityTile name="Acme" />);
    expect(container.querySelector("[data-entity-tile]")).toHaveClass("bg-subtle");
    expect(container.querySelector("[data-entity-tile]")).toHaveTextContent("A");
  });
});

describe("EntityLabel", () => {
  it("puts the icon to the left of the name, and adds nothing when there is none", () => {
    const { container, rerender } = render(<EntityLabel icon="package">Orders</EntityLabel>);
    const html = container.innerHTML;
    expect(html.indexOf("lucide-package")).toBeGreaterThan(-1);
    expect(html.indexOf("lucide-package")).toBeLessThan(html.indexOf("Orders"));
    rerender(<EntityLabel>Orders</EntityLabel>);
    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("Orders");
  });
});
