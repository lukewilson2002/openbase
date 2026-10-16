import { describe, expect, it } from "vitest";
import { accentClass, accentHue } from "./colors";
import { workspaceColor } from "./workspaceColor";

describe("workspaceColor", () => {
  it("uses the workspace's own colour when it has one", () => {
    expect(workspaceColor({ name: "Household", color: "green" })).toBe("green");
    expect(workspaceColor({ name: "Household", color: "pink_dark" })).toBe("pink_dark");
  });

  it("falls back to a colour picked from the name, the same every time", () => {
    const a = workspaceColor({ name: "Side business" });
    expect(workspaceColor({ name: "Side business", color: null })).toBe(a);
    expect(workspaceColor({ name: "  side BUSINESS " })).toBe(a);
    expect(workspaceColor({ name: "Side business", color: "not-a-colour" })).toBe(a);
  });

  it("spreads different names over different colours", () => {
    const names = ["Household", "Side business", "Personal", "Work", "Club", "Garden", "Band", "Family"];
    expect(new Set(names.map((name) => workspaceColor({ name }))).size).toBeGreaterThan(3);
  });
});

describe("accent classes", () => {
  it("share one hue between a colour and its dark variant, and fall back to gray", () => {
    expect(accentHue("green_dark")).toBe("green");
    expect(accentHue("blue")).toBe("blue");
    expect(accentHue(null)).toBe("gray");
    expect(accentClass("purple", "solid")).toBe("ob-hue-purple ob-solid");
    expect(accentClass("nope", "button")).toBe("ob-hue-gray ob-tint-button");
  });
});
