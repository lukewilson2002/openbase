import { describe, expect, it } from "vitest";
import { normalizeMarkdown } from "./extensions";

const CASES: Record<string, string> = {
  headings: "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six",
  marks: "A **bold** and *italic* and ~~struck~~ and `code` and [a link](https://example.com) here.",
  "nested bullet list": "- one\n  - two\n    - three\n  - back\n- four",
  "ordered list starting at 5": "5. five\n6. six\n7. seven",
  "nested ordered list": "1. one\n   1. inner\n2. two",
  "task list": "- [ ] open\n- [x] done\n  - [ ] nested",
  "block quote": "> quoted\n>\n> second paragraph",
  "callout note": "> [!NOTE]\n> Useful context.",
  "callout tip": "> [!TIP]\n> Try this.",
  "callout important": "> [!IMPORTANT]\n> Do not skip.",
  "callout warning": "> [!WARNING]\n> Back up first.\n>\n> Twice.",
  "callout caution": "> [!CAUTION]\n> Sharp edges.",
  // Columns are padded to a common width, so this is the normalized form.
  table: "| A   | B   | C   |\n| --- | --- | --- |\n| 1   | 2   | 3   |",
  "table between paragraphs": "before\n\n| A   | B   |\n| --- | --- |\n| 1   | 2   |\n\nafter",
  "callout with a list": "> [!TIP]\n> Steps:\n>\n> - one\n> - two",
  "two lines in one paragraph": "first line\nsecond line",
  "plain text with symbols": "snake_case_name and 2 * 3 and a < b",
  "escaped markup stays literal": "\\*not bold\\* and \\_not italic\\_ and \\`no code\\` and a &lt;b> tag and \\[x\\]",
  "text that only looks like block syntax": "\\## not a heading\n\n1\\. not a list\n\n\\- not a bullet\n\n\\> not a quote\n\n\\---",
  "bold with an underscore inside": "**snake_case**",
  "empty value": "",
  "code block": "```ts\nconst a = 1;\n```",
  "horizontal rule": "above\n\n---\n\nbelow",
};

describe("rich text Markdown layer", () => {
  for (const [name, md] of Object.entries(CASES)) {
    it(`${name}: md -> document -> md is stable`, () => {
      const once = normalizeMarkdown(md);
      expect(once).toBe(md);
      expect(normalizeMarkdown(once)).toBe(once);
    });
  }

  it("keeps the start number of an ordered list", () => {
    expect(normalizeMarkdown("5. five\n6. six")).toMatch(/^5\. five\n6\. six$/);
  });

  it("leaves an ordinary quote a quote, not a callout", () => {
    expect(normalizeMarkdown("> [not an alert]\n> text")).not.toMatch(/\[!/);
  });
});
