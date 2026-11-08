// Tests for the design-token check's detector and list rules (scripts/check-tokens.mjs). They live
// here, not in scripts/, because Vitest only serves test files inside web/. Plain .mjs: the script
// is plain Node and has no types.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findViolations,
  isPermanentlyExempt,
  parseTemporaryList,
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
    'className="text-[0.8125rem] text-sm text-ui text-label text-meta"',
    'className="text-[var(--size)] text-[length:var(--size)]"',
    'className="leading-[18px] tracking-[0.2px] border-[1px]"',
    "const s = { width: 13, height: '13px', padding: '4px 8px' };",
    "const s = { fontSize: size };",
    "const s = { fontSize: `${size * rem}px` };",
    "const s = { fontSize: Math.max(8, Math.round(size / 4.5)) };",
    'const s = { fontSize: "0.8125rem" };',
    'const s = { fontSize: "1.2em" };',
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
    expect(isPermanentlyExempt(rel)).toBe(true);
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
    expect(isPermanentlyExempt(rel)).toBe(false);
  });
});

describe("the temporary list", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tree(files, list, baseline = list) {
    const dir = mkdtempSync(path.join(tmpdir(), "check-tokens-"));
    dirs.push(dir);
    const srcDir = path.join(dir, "src");
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(srcDir, rel)), { recursive: true });
      writeFileSync(path.join(srcDir, rel), content);
    }
    const listFile = path.join(dir, "list.txt");
    writeFileSync(listFile, list);
    const baselineFile = path.join(dir, "baseline.txt");
    if (baseline !== null) writeFileSync(baselineFile, baseline);
    return { srcDir, listFile, baselineFile };
  }

  const bad = 'export const c = "#fff";\n';
  const good = 'export const c = "var(--fg)";\n';

  it("passes when every violating file is listed and every listed file still violates", () => {
    const r = runCheck(tree({ "a/Bad.tsx": bad, "b/Good.tsx": good }, "# note\n\na/Bad.tsx\n"));
    expect(r.violations.size).toBe(0);
    expect(r.problems).toEqual([]);
    expect(r.temporary).toEqual(["a/Bad.tsx"]);
  });

  it("fails on a violating file that is on neither list", () => {
    const r = runCheck(tree({ "a/Bad.tsx": bad }, ""));
    expect([...r.violations.keys()]).toEqual(["a/Bad.tsx"]);
  });

  it("fails on a listed file with nothing left to flag", () => {
    const r = runCheck(tree({ "b/Good.tsx": good }, "b/Good.tsx\n"));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/b\/Good\.tsx: no raw colour or px font size left/);
  });

  it("fails on a listed file that is missing", () => {
    const r = runCheck(tree({ "b/Good.tsx": good }, "gone/File.tsx\n"));
    expect(r.problems[0]).toMatch(/gone\/File\.tsx: no such file/);
  });

  it("fails on a listed file that is exempt for good, and on a duplicate entry", () => {
    const r = runCheck(
      tree({ "lib/colors.ts": bad, "a/Bad.tsx": bad }, "lib/colors.ts\na/Bad.tsx\na/Bad.tsx\n"),
    );
    expect(r.problems.some((p) => /lib\/colors\.ts: already exempt/.test(p))).toBe(true);
    expect(r.problems.some((p) => /duplicate/.test(p))).toBe(true);
  });

  it("never scans exempt files", () => {
    const r = runCheck(
      tree({ "lib/colors.ts": bad, "x.test.ts": bad, "views/grid/glide/t.ts": bad, "styles/t.css": "a{color:#fff}" }, ""),
    );
    expect(r.violations.size).toBe(0);
    expect(r.scanned).toBe(0);
  });

  it("fails on a file added to the list that the baseline never held, so the list cannot grow", () => {
    const r = runCheck(tree({ "a/Old.tsx": bad, "a/New.tsx": bad }, "a/Old.tsx\na/New.tsx\n", "# frozen\na/Old.tsx\n"));
    expect(r.violations.size).toBe(0);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/a\/New\.tsx: was not on the list when it was frozen/);
  });

  it("lets the list shrink below the baseline", () => {
    const r = runCheck(tree({ "a/Old.tsx": bad }, "a/Old.tsx\n", "a/Old.tsx\na/Fixed.tsx\n"));
    expect(r.problems).toEqual([]);
  });

  it("fails when the baseline file is missing", () => {
    const r = runCheck(tree({ "a/Bad.tsx": bad }, "a/Bad.tsx\n", null));
    expect(r.problems.some((p) => /baseline.txt is missing/.test(p))).toBe(true);
  });

  it("parses one path per line and skips comments and blanks", () => {
    expect(parseTemporaryList("# c\n\n  a.ts  \nb/c.tsx\n")).toEqual(["a.ts", "b/c.tsx"]);
  });
});

describe("the real tree", () => {
  it("is green: no violation outside the lists, no stale temporary entry", () => {
    const r = runCheck();
    expect([...r.violations.keys()]).toEqual([]);
    expect(r.problems).toEqual([]);
  });
});
