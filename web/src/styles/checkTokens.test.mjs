// Tests for the design-token check's detector and exempt files (scripts/check-tokens.mjs). They live
// here, not in scripts/, because Vitest only serves test files inside web/. Plain .mjs: the script
// is plain Node and has no types.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findViolations,
  isExempt,
  runCheck,
  stripComments,
} from "../../../scripts/check-tokens.mjs";

const kinds = (src, file) => findViolations(src, file).map((v) => v.kind);
const flags = (src, file) => findViolations(src, file).length > 0;

describe("raw hex colours", () => {
  it.each([
    'const c = "#fff";',
    "const c = '#1F5AE0';",
    'style={{ color: "#1f5ae080" }}',
    'className="bg-[#1f5ae0] text-[#fff]"',
    'className="shadow-[0_1px_2px_#0003]"',
    'className="shadow-[0_0_0_1px_#0003]"',
    "color: #abc;",
    "border: 1px solid #DFE3EA;",
    "const c = `#12${x}`; const d = `#123456`;",
  ])("flags %s", (src) => {
    expect(kinds(src)).toContain("hex colour");
  });

  it.each([
    'href="#"',
    'href="#main-content"',
    'href="#section"',
    'to="/page#anchor"',
    'url("/a/b/#abcdef")',
    'fill="url(#abc)"',
    'fill="url( #grad )"',
    "const id = `row#${n}`;",
    'const key = "item#1234567";',
    'const s = "&#x1F600; &#128512;";',
    'const label = "Step #1 of 5";',
    'const tag = "#12345";',
    "const x = a#b;",
    "const rx = /#[a-z]+/;",
    '// color: #ff0000 in a line comment',
    "/* the old #1f5ae0 */ const x = 1;",
    "{/* #fff */}",
    "document.querySelector('#root')",
    'const hash = "#add-row";',
  ])("ignores %s", (src) => {
    expect(kinds(src)).not.toContain("hex colour");
  });

  it("reports the line and column", () => {
    const [v] = findViolations('const a = 1;\nconst b = "x #fff";\n');
    expect(v).toMatchObject({ line: 2, col: 14, kind: "hex colour", text: "#fff" });
  });
});

describe("rgb, rgba, hsl and hsla colours", () => {
  it.each([
    'background: "rgb(15 20 30 / 0.4)"',
    "background: rgba(0, 0, 0, 0.5);",
    'className="shadow-[0_1px_2px_rgb(15_20_30/0.06)]"',
    'className="shadow-[0_1px_2px_RGBA(15_20_30/0.06)]"',
    "color: hsl(210 50% 40%);",
    "color: hsla(210, 50%, 40%, 0.5);",
  ])("flags %s", (src) => {
    expect(kinds(src, "x.css")).toContain("rgb/hsl colour");
  });

  it.each([
    "color-mix(in srgb, var(--accent) 13%, var(--surface))",
    "const srgb = convert(x);",
    "function rgbToHex(c) {}",
    "const toRgb = (c) => c;",
    "// background: rgb(0 0 0)",
    "/* rgba(0, 0, 0, 0.5) */",
    "const note = 'use a token, not rgb'",
  ])("ignores %s", (src) => {
    expect(kinds(src)).not.toContain("rgb/hsl colour");
  });
});

describe("px font sizes", () => {
  it.each([
    'className="text-[13px] font-medium"',
    'className="md:text-[13px]"',
    'className="hover:!text-[11.5px]"',
    'className="text-[length:13px]"',
    'className="text-[0.8125rem]"',
    'className="md:text-[length:0.875rem] text-[1.1em]"',
    'const s = { fontSize: "0.8125rem" };',
    'const s = { fontSize: "1.2em" };',
    "const s = { fontSize: 13 };",
    "const s = { fontSize: 13.5 };",
    'const s = { fontSize: "13px" };',
    "const s = { fontSize: '13px' };",
    "<text fontSize={13} />",
    "<text fontSize=\"13\" />",
    'const s = { fontSize: "max(13px, 1em)" };',
    "const fontSize = 14;",
    "font-size: 13px;",
    "font-size: .8px;",
    "font-size: max(16px, 1em);",
    "  font-size : 13px ;",
    'className="[font-size:13px]"',
    '<text font-size="13" />',
    "font: 13px/1.4 sans-serif;",
    'ctx.font = "600 13px Inter, sans-serif";',
    "ctx.font = '12px ' + family;",
    "const s = { fontSize: big ? 16 : 13 };",
    "const s = { fontSize: compact ? 12 : 14, color: x };",
    "const s = { fontSize: x || 13 };",
    "const s = { fontSize: x ?? 13 };",
    "<text fontSize={wide ? 15 : size} />",
    '<text fontSize={wide ? "15px" : size} />',
    "const s = { fontSize: (big ? size : 13) };",
    "const s = {\n  fontSize: big\n    ? 16\n    : 13,\n};",
    'const s = { "font-size": "13px" };',
    "const s = { 'font-size': 13 };",
    'el.style["font-size"] = "13px";',
    'el.style.setProperty("font-size", "13px");',
    "el.style.setProperty('font-size', '12.5px');",
    "const css = `font-size:${13}px`;",
    "const s = { fontSize: `${13}px` };",
  ])("flags %s", (src) => {
    expect(kinds(src, "x.tsx")).toContain("px font size");
  });

  it.each([
    'className="w-[13px] h-[13px] gap-[8px] top-[13px] rounded-[10px]"',
    'className="text-sm text-ui text-label text-meta text-initial"',
    'className="text-[var(--size)] text-[length:var(--size)]"',
    'className="leading-[18px] tracking-[0.2px] border-[1px]"',
    "const s = { width: 13, height: '13px', padding: '4px 8px' };",
    "const s = { fontSize: size };",
    "const s = { fontSize: `${size * rem}px` };",
    "const s = { fontSize: Math.max(8, Math.round(size / 4.5)) };",
    'const s = { fontSize: "120%" };',
    "<text fontSize={size} />",
    "font-size: 0.8125rem;",
    "font-size: 1.25em;",
    "font-size: 100%;",
    "font-size: var(--text-ui);",
    "border: 1px solid var(--line);",
    "margin: 0 13px;",
    "ctx.font = `${weight} ${size * rem}px ${family}`;",
    "font: inherit;",
    "const font = loadFont();",
    "--font-sans: ui-sans-serif, system-ui;",
    "// fontSize: 13",
    "/* font-size: 13px */",
    "const thirteenPx = 13;",
    'const m = window.matchMedia("(min-width: 1024px)");',
    "const s = { fontSize: big ? size : size * 1.2 };",
    'const s = { fontSize: big ? "1.2em" : "0.8125rem" };',
    "const s = { fontSize: x || size, lineHeight: 13 };",
    "const s = { fontSize: size, width: big ? 16 : 13 };",
    "const s = { fontSize: big ? size : Math.max(8, size) };",
    'const s = { "font-size": "inherit", "line-height": "13px" };',
    'el.style.setProperty("line-height", "13px");',
    'el.style.setProperty("font-size", `${size}px`);',
    "const css = `font-size:${size}px`;",
  ])("ignores %s", (src) => {
    expect(kinds(src, "x.tsx")).not.toContain("px font size");
  });
});

describe("Tailwind palette colours", () => {
  it.each([
    'className="bg-white"',
    'className="bg-black/60 text-white"',
    'className="border border-black/10"',
    'className="hover:bg-black/5 dark:text-white/70"',
    'className="border-slate-200 text-gray-500 ring-blue-500"',
    'className="fill-white stroke-black"',
    'className="from-white to-black"',
    'className="bg-white/[0.8] border-t-black"',
    'className="!bg-white"',
    "cn(on && 'text-white')",
  ])("flags %s", (src) => {
    expect(kinds(src)).toContain("palette colour");
  });

  it.each([
    'className="bg-surface text-fg border-line bg-fg/10 hover:bg-hover"',
    'className="bg-paper text-paper bg-scrim"',
    'className="text-primary-fg bg-overlay"',
    'className="whitespace-nowrap white-space"',
    'className="bg-white-ish"',
    'const note = "next-to-black"',
    'className="text-black-ish"',
    "// bg-white in a comment",
    'className="border-blue"',
    'className="bg-red-5"',
  ])("ignores %s", (src) => {
    expect(kinds(src)).not.toContain("palette colour");
  });
});

describe("comments and strings", () => {
  it("ignores colours in line, block and JSX comments but not code next to them", () => {
    const src = [
      "// #fff",
      "const a = 1; // rgb(0 0 0)",
      "/* multi",
      "   line #123456 */",
      "const b = '#123456'; /* trailing */",
      "{/* text-[13px] */}",
    ].join("\n");
    const found = findViolations(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 5, text: "#123456" });
  });

  it("does not take // inside a string or a URL for a comment", () => {
    expect(flags('const u = "https://example.com/a"; const c = "#fff";')).toBe(true);
    expect(flags("const u = `https://example.com/${id}`; const c = `#fff`;")).toBe(true);
  });

  it("reads template literals with nested expressions", () => {
    expect(flags("const s = `a ${cond ? `b ${x}` : ''} #fff`;")).toBe(true);
    expect(flags("const s = `a ${ {a: 1}.a } // not a comment #fff`;")).toBe(true);
    expect(flags("const s = `${a} ${b}`; // #fff")).toBe(false);
  });

  it("survives an apostrophe in JSX text and a quote in a regex", () => {
    expect(flags("<p>Don't worry</p>\nconst c = '#fff';")).toBe(true);
    expect(flags("const re = /['\"]/;\n// #fff\nconst x = 1;")).toBe(false);
  });

  it("keeps line numbers when blanking comments", () => {
    const src = "a\n/* x\ny */\nb // c\n";
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out.length).toBe(src.length);
  });

  it("does not read // as a comment in CSS", () => {
    expect(flags("a { background: url(//cdn.example.com/x.png); color: #fff; }", "x.css")).toBe(true);
    expect(flags("a { background: url(//cdn.example.com/x.png); }", "x.css")).toBe(false);
  });

  it("reports one violation per spot when two patterns match it", () => {
    const found = findViolations('const s = { fontSize: "13px" };').filter((v) => v.kind === "px font size");
    expect(found).toHaveLength(1);
  });
});

describe("the permanent exempt list", () => {
  it.each([
    "styles/index.css",
    "styles/accents.css",
    "theme/accents.ts",
    "lib/colors.ts",
    "lib/cells/palette.ts",
    "views/grid/glide/theme.ts",
    "views/grid/glide/cells/deep/x.ts",
    "components/brandMarks.ts",
    "pages/account/AssistantMarks.tsx",
    "lib/colors.test.ts",
    "components/Foo.test.tsx",
    "api/client.spec.ts",
    "test/setup.ts",
    "test/utils.tsx",
  ])("exempts %s", (rel) => {
    expect(isExempt(rel)).toBe(true);
  });

  it.each([
    "views/calendar/calendar.css",
    "onboarding/intro.css",
    "styles/nested/other.css",
    "views/grid/GridView.tsx",
    "views/grid/glideish/x.ts",
    "components/brandMarksExtra.ts",
    "lib/colorsExtra.ts",
    "lib/cells/palette.tsx",
    "components/latest.tsx",
    "components/Foo.test-helpers.tsx",
  ])("does not exempt %s", (rel) => {
    expect(isExempt(rel)).toBe(false);
  });
});

describe("the check", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tree(files) {
    const dir = mkdtempSync(path.join(tmpdir(), "check-tokens-"));
    dirs.push(dir);
    const srcDir = path.join(dir, "src");
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(srcDir, rel)), { recursive: true });
      writeFileSync(path.join(srcDir, rel), content);
    }
    return { srcDir };
  }

  const bad = 'export const c = "#fff";\n';
  const good = 'export const c = "var(--fg)";\n';

  it("fails on every file with a literal, and only on those", () => {
    const r = runCheck(tree({ "a/Bad.tsx": bad, "b/Good.tsx": good }));
    expect([...r.violations.keys()]).toEqual(["a/Bad.tsx"]);
    expect(r.scanned).toBe(2);
  });

  it("never scans exempt files", () => {
    const r = runCheck(
      tree({ "lib/colors.ts": bad, "x.test.ts": bad, "views/grid/glide/t.ts": bad, "styles/t.css": "a{color:#fff}" }),
    );
    expect(r.violations.size).toBe(0);
    expect(r.scanned).toBe(0);
  });
});

describe("the real tree", () => {
  it("is green: no literal colour or px font size outside the exempt files", () => {
    const r = runCheck();
    expect([...r.violations.keys()]).toEqual([]);
  });
});
