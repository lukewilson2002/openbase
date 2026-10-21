import { describe, expect, it } from "vitest";
import { DARK_THEME, LIGHT_THEME } from "./theme";
import { ADD_ICON, headerIcons } from "./icons";

describe("header icons", () => {
  it("stroke in the header icon colour of each theme, not the colour meant for a filled box", () => {
    const sprites = headerIcons();
    for (const theme of [LIGHT_THEME, DARK_THEME]) {
      for (const key of ["text", ADD_ICON]) {
        const svg = sprites[key]!({ bgColor: theme.bgIconHeader!, fgColor: theme.fgIconHeader! });
        expect(svg).toContain(`stroke="${theme.bgIconHeader}"`);
        expect(svg).not.toContain(theme.fgIconHeader!);
      }
    }
  });
});
