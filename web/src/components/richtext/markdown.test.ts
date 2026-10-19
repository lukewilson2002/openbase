import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { normalizeMarkdown, richTextExtensions } from "./extensions";

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
  // Two empty paragraphs: the second is written as the library's mark for one.
  "blank lines between paragraphs": "a\n\n\n\n&nbsp;\n\nb",
  "runs of spaces": "a   b  c",
  "a tilde, escaped once": "yo\\~!!!!",
  "entities and spaces in code stay as typed": "```\nx  ~ &nbsp; &amp;\n```\n\nand `a~b &nbsp;`",
  "ampersands": "R&D and a & b and &amp;copy; written out",
  "media between paragraphs": "before\n\n![A photo](/api/attachments/att_1/photo.png \"Caption\")\n\nafter",
};

/** Values that may change once on their way in (to the form the editor writes) but never after. */
const SETTLING = [
  "a&nbsp;b",
  "&copy; 2026",
  "x~y~z",
  "café ~ mañana",
  "trailing  \nbreak",
  "\u00a0lead and a\u00a0\u00a0b",
  "<b>x</b> and 1 < 2 > 0",
  "a\\b and a\\*b and [x] and *",
  "- [ ] task ~\n  - nested &nbsp;\n\n> [!NOTE]\n> a ~ b\n\n\n\n&nbsp;\n\n#####",
  "[link](https://x.y/a_b~c) and ![other](https://elsewhere.example/a.png)",
];

const p = (text?: string): JSONContent => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) });

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

  for (const md of SETTLING) {
    it(`settles after one pass: ${JSON.stringify(md)}`, () => {
      const once = normalizeMarkdown(md);
      const twice = normalizeMarkdown(once);
      expect(twice).toBe(once);
      expect(normalizeMarkdown(twice)).toBe(once);
    });
  }

  it("saves and reloads empty paragraphs as they are, however often", () => {
    const content = [p("a"), p(), p(), p(), p("b"), p(), p("c\u00a0\u00a0d")];
    const editor = new Editor({ element: null, extensions: richTextExtensions(), content: { type: "doc", content } });
    try {
      const md = editor.getMarkdown();
      for (let i = 0; i < 3; i++) {
        editor.commands.setContent(editor.getMarkdown(), { contentType: "markdown" });
        expect(editor.getJSON().content).toEqual(content);
        expect(editor.getMarkdown()).toBe(md);
      }
    } finally {
      editor.destroy();
    }
  });

  it("mends blank lines saved escaped (&amp;nbsp;) by earlier versions", () => {
    expect(normalizeMarkdown("a\n\n\n\n&amp;nbsp;\n\nb")).toBe("a\n\n\n\n&nbsp;\n\nb");
    expect(normalizeMarkdown("Yo\\~!!!!\n\n&amp;nbsp;\n\n\\#####\n\n&amp;nbsp;")).toBe("Yo\\~!!!!\n\n\n\n\\#####");
    // In the middle of a line it is text someone typed.
    expect(normalizeMarkdown("a &amp;nbsp; b")).toBe("a &amp;nbsp; b");
  });
});
