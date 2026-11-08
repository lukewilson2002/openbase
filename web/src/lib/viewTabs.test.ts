import { describe, expect, it } from "vitest";
import { makeView } from "@/test/utils";
import { defaultTabLabel, dropOrder, fitTabs, siblingIds, viewTabs } from "./viewTabs";

const views = [
  makeView({ id: "viwD", name: "Default grid", is_default: true }),
  makeView({ id: "viwA", name: "Open deals" }),
  makeView({ id: "viwB", name: "Board", type: "kanban" }),
  makeView({ id: "viwC", name: "Mine", personal: true }),
  makeView({ id: "viwE", name: "Mine too", personal: true }),
];

describe("view tabs", () => {
  it("reads All and the collection's name, lowercased, for the default view", () => {
    expect(defaultTabLabel("Clients")).toBe("All clients");
    expect(defaultTabLabel("  Q4 Deals ")).toBe("All q4 deals");
  });

  it("puts the default view first even when the server lists it last, and keeps the others in order", () => {
    const tabs = viewTabs({ name: "Clients", views: [...views.slice(1), views[0]!] });
    expect(tabs.map((t) => t.label)).toEqual(["All clients", "Open deals", "Board", "Mine", "Mine too"]);
    expect(tabs[0]!.view.id).toBe("viwD");
  });

  it("starts with the first saved view in a collection that has no default view", () => {
    expect(viewTabs({ name: "Clients", views: views.slice(1) }).map((t) => t.label)).toEqual(["Open deals", "Board", "Mine", "Mine too"]);
  });
});

describe("fitTabs", () => {
  const widths = [100, 80, 90, 70, 60];

  it("keeps every tab when they all fit, with no room reserved for More", () => {
    expect(fitTabs(widths, 400, 50, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(fitTabs(widths, 399, 50, 0)).not.toEqual([0, 1, 2, 3, 4]);
  });

  it("moves the tabs that do not fit into More, from the right, keeping room for the More button", () => {
    // 300 - 50 for More leaves 250: 100 + 80 fits, the next 90 would make 270.
    expect(fitTabs(widths, 300, 50, 0)).toEqual([0, 1]);
    expect(fitTabs(widths, 300, 50, 1)).toEqual([0, 1]);
  });

  it("shows the open tab in place of the last tabs that fit when it is one of those in More", () => {
    expect(fitTabs(widths, 300, 50, 4)).toEqual([0, 1, 4]);
    // The open tab needs more room than one tab gives up.
    expect(fitTabs([100, 80, 90, 200], 330, 50, 3)).toEqual([0, 3]);
  });

  it("never drops the first tab, however little room there is", () => {
    expect(fitTabs(widths, 20, 50, 3)).toEqual([0, 3]);
    expect(fitTabs(widths, 20, 50, 0)).toEqual([0]);
  });

  it("treats tabs not measured yet (width 0) as fitting", () => {
    expect(fitTabs([0, 0, 0], 0, 50, 0)).toEqual([0, 1, 2]);
  });
});

describe("dropOrder", () => {
  it("moves a shared view among the shared ones", () => {
    expect(dropOrder(views, "viwB", "viwA")).toEqual(["viwB", "viwA"]);
    expect(dropOrder(views, "viwA", "viwB")).toEqual(["viwB", "viwA"]);
  });

  it("moves a personal view among the personal ones", () => {
    expect(dropOrder(views, "viwE", "viwC")).toEqual(["viwE", "viwC"]);
  });

  it("changes nothing for a drop on itself, on the other kind or on the default view", () => {
    expect(dropOrder(views, "viwA", "viwA")).toBeNull();
    expect(dropOrder(views, "viwA", "viwC")).toBeNull();
    expect(dropOrder(views, "viwA", "viwD")).toBeNull();
    expect(dropOrder(views, "viwD", "viwA")).toBeNull();
    expect(dropOrder(views, "nope", "viwA")).toBeNull();
  });
});

describe("siblingIds", () => {
  it("lists the views of the same kind, not the default view", () => {
    expect(siblingIds(views, views[1]!)).toEqual(["viwA", "viwB"]);
    expect(siblingIds(views, views[3]!)).toEqual(["viwC", "viwE"]);
  });
});
