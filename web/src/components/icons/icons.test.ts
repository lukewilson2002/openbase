import { describe, expect, it } from "vitest";
import { POPULAR_ICONS, humanizeIconName } from "./popular";
import { searchIcons } from "./search";
import { fakeIconSet } from "./testSet";
import { iconPatch } from "./iconPatch";

describe("the popular icons", () => {
  it("are 20 distinct kebab-case names, the number the server accepts", () => {
    expect(POPULAR_ICONS).toHaveLength(20);
    expect(new Set(POPULAR_ICONS.map((p) => p.name)).size).toBe(20);
    for (const { name } of POPULAR_ICONS) expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it("are all in the real Lucide set, under their canonical names, and the set is the size the picker expects", async () => {
    const { fullIconSet } = await import("./fullSet");
    expect(fullIconSet.names.length).toBeGreaterThan(1500);
    expect(fullIconSet.names).toEqual([...fullIconSet.names].sort());
    for (const { name } of POPULAR_ICONS) expect(fullIconSet.names, name).toContain(name);
    for (const name of fullIconSet.names) expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    // aliases draw too, so an icon saved under an old name keeps rendering
    expect(fullIconSet.nodes.has("home")).toBe(true);
    expect(fullIconSet.aliases.get("house")).toContain("home");
  });

  it("are found by searching the real set", async () => {
    const { fullIconSet } = await import("./fullSet");
    expect(searchIcons(fullIconSet, "shopping cart")[0]).toBe("shopping-cart");
    expect(searchIcons(fullIconSet, "home")[0]).toBe("house");
    expect(searchIcons(fullIconSet, "truck")[0]).toBe("truck");
    expect(searchIcons(fullIconSet, "zzzzqqq")).toEqual([]);
  });
});

describe("humanizeIconName", () => {
  it("makes accessible names", () => {
    expect(humanizeIconName("chart-column")).toBe("Chart column");
    expect(humanizeIconName("building-2")).toBe("Building 2");
    expect(humanizeIconName("star")).toBe("Star");
  });
});

describe("searchIcons", () => {
  const set = fakeIconSet(5);

  it("returns everything for an empty query", () => {
    expect(searchIcons(set, "  ")).toEqual(set.names);
  });

  it("ranks an exact name, then a prefix, then a word prefix, then a substring", () => {
    expect(searchIcons(set, "chart")).toEqual(["chart-pie", "chart-line", "chart-column"]);
    expect(searchIcons(set, "pie")).toEqual(["chart-pie"]);
    expect(searchIcons(set, "ar")).toContain("target");
    expect(searchIcons(set, "star")[0]).toBe("star");
  });

  it("matches aliases, and every word of a multi-word query", () => {
    expect(searchIcons(set, "home")).toEqual(["house"]);
    expect(searchIcons(set, "bar chart")).toContain("chart-column");
    expect(searchIcons(set, "cart shopping")).toEqual(["shopping-cart"]);
    expect(searchIcons(set, "cart nothing")).toEqual([]);
  });

  it("is case-insensitive and treats spaces, dashes and underscores alike", () => {
    expect(searchIcons(set, "SHOPPING_CART")).toEqual(["shopping-cart"]);
    expect(searchIcons(set, "Shopping-Cart")).toEqual(["shopping-cart"]);
  });

  it("searches only the popular icons until the full set has loaded", () => {
    expect(searchIcons(null, "cart")).toEqual(["shopping-cart"]);
    expect(searchIcons(null, "pie")).toEqual([]);
    expect(searchIcons(null, "")).toHaveLength(20);
  });
});

describe("iconPatch", () => {
  it("is empty when the icon did not change, so the server leaves it alone", () => {
    expect(iconPatch(null, null)).toEqual({});
    expect(iconPatch(undefined, null)).toEqual({});
    expect(iconPatch("star", "star")).toEqual({});
  });

  it("sets or clears otherwise (null clears)", () => {
    expect(iconPatch(null, "star")).toEqual({ icon: "star" });
    expect(iconPatch("star", "truck")).toEqual({ icon: "truck" });
    expect(iconPatch("star", null)).toEqual({ icon: null });
  });
});
