import { describe, expect, it } from "vitest";
import { normalizeMarkdown } from "./extensions";

const CASES: Record<string, string> = {
  "image with alt text and a caption": '![A red door](/api/attachments/att_1/door.png "The front door")',
  "image with no alt text and no caption": "![](/api/attachments/att_1/door.png)",
  "image with a caption only": '![](/api/attachments/att_1/door.png "Caption")',
  "image with alt text only": "![A red door](/api/attachments/att_1/door.png)",
  video: '![Tour](/api/attachments/att_2/tour.mp4 "Walk-through")',
  audio: "![](/api/attachments/att_3/memo.m4a)",
  "other file": '![Q3 numbers](/api/attachments/att_4/report.pdf "Report")',
  "file name with spaces and unicode": "![](/api/attachments/att_5/Caf%C3%A9%20menu%20%E2%80%93%20d%C3%A9j%C3%A0%20vu.png)",
  "file name with parentheses": "![](/api/attachments/att_5/photo%20%281%29.png)",
  "alt text and caption with markup characters": '![a \\[b\\] c](/api/attachments/att_1/x.png "say \\"hi\\" \\\\ ok")',
  "an embed between paragraphs": "before\n\n![A red door](/api/attachments/att_1/door.png)\n\nafter",
  "two embeds in a row": "![](/api/attachments/att_1/a.png)\n\n![](/api/attachments/att_2/b.mp4)",
  "an embed after a heading and before a list": "# Title\n\n![](/api/attachments/att_1/a.png)\n\n- one\n- two",
};

describe("media blocks in Markdown", () => {
  for (const [name, md] of Object.entries(CASES)) {
    it(`${name}: md -> document -> md is stable`, () => {
      expect(normalizeMarkdown(md)).toBe(md);
    });
  }

  it("lifts an image out of the middle of a paragraph into a block of its own", () => {
    expect(normalizeMarkdown("see ![x](/api/attachments/att_1/a.png) here")).toBe("see\n\n![x](/api/attachments/att_1/a.png)\n\nhere");
  });

  it("lifts an image that follows text on the previous line", () => {
    expect(normalizeMarkdown("first line\n![x](/api/attachments/att_1/a.png)")).toBe("first line\n\n![x](/api/attachments/att_1/a.png)");
  });

  it("writes consecutive image lines as separate blocks", () => {
    expect(normalizeMarkdown("![a](/api/attachments/att_1/a.png)\n![b](/api/attachments/att_2/b.png)")).toBe("![a](/api/attachments/att_1/a.png)\n\n![b](/api/attachments/att_2/b.png)");
  });

  it("reads an image of an outside address as a link, never as media", () => {
    expect(normalizeMarkdown("![logo](https://example.test/logo.png)")).toBe("[logo](https://example.test/logo.png)");
    expect(normalizeMarkdown("![](https://example.test/logo.png)")).toBe("[https://example.test/logo.png](https://example.test/logo.png)");
    expect(normalizeMarkdown("a ![x](https://example.test/a.png) b")).toBe("a [x](https://example.test/a.png) b");
  });

  it("reads other images that are not one of our files as links", () => {
    for (const src of ["data:image/png;base64,AAAA", "pics/a.png", "//example.test/a.png", "/api/attachments/att_1/a.png?share=x", "/api/attachments/att_1/", "/api/attachments/../secret", "/other/att_1/a.png"]) {
      const out = normalizeMarkdown(`![x](${src})`);
      expect(out, src).toBe(`[x](${src})`);
    }
  });

  it("keeps an embed in a list item and a quote", () => {
    expect(normalizeMarkdown("- item\n\n  ![](/api/attachments/att_1/a.png)")).toContain("![](/api/attachments/att_1/a.png)");
    expect(normalizeMarkdown("> quoted\n>\n> ![](/api/attachments/att_1/a.png)")).toContain("![](/api/attachments/att_1/a.png)");
    expect(normalizeMarkdown("> ![](/api/attachments/att_1/a.png)")).toContain("![](/api/attachments/att_1/a.png)");
  });

  it("keeps the file reachable as a link where a block cannot stand (the first line of a list item)", () => {
    const out = normalizeMarkdown("- ![](/api/attachments/att_1/a.png)");
    expect(out).toContain("](/api/attachments/att_1/a.png)");
    expect(out).not.toContain("![");
  });
});
