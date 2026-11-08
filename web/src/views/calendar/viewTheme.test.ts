import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The calendar's and the timeline's stylesheets (COL-7) draw every surface, line and event from the design
 * tokens, so both themes follow without a rule of their own. This reads them as written: each colour
 * variable they use must exist in the light and the dark block of styles/index.css (or be a size, radius,
 * duration or the per-choice colour a choice class sets), and none may hold a raw colour.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const index = read("src/styles/index.css");

function names(block: RegExp): Set<string> {
  const body = block.exec(index)?.[1];
  if (!body) throw new Error(`no block for ${block}`);
  return new Set([...body.matchAll(/(--[a-z0-9-]+):/gi)].map((m) => m[1]!));
}
const light = names(/:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/);
const dark = names(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
const shared = /^--(text|space|radius|duration|ease|mark)-/;
// FullCalendar's own variables are set in these files; `--c-bg` comes from the choice class on the element.
const own = /^--(fc-|c-bg$)/;

describe.each([
  ["the calendar", "src/views/calendar/calendar.css"],
  ["the timeline", "src/views/timeline/timeline.css"],
])("%s stylesheet", (_name, path) => {
  const css = read(path);

  it("reads only tokens both themes define", () => {
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const v of new Set(used)) {
      if (shared.test(v) || own.test(v)) continue;
      expect(light.has(v), `${v} in the light theme`).toBe(true);
      expect(dark.has(v), `${v} in the dark theme`).toBe(true);
    }
  });

  it("holds no raw colour and no shadow of its own", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/i);
    // Lines and fills, not elevation: the only box-shadow left is an inset edge.
    for (const m of css.matchAll(/box-shadow:\s*([^;]+);/g)) expect(m[1]).toMatch(/^inset /);
  });
});
