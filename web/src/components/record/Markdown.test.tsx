import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, markdownToText, renderMarkdown } from "./Markdown";

function html(source: string): HTMLElement {
  const { container } = render(<Markdown source={source} />);
  return container.firstElementChild as HTMLElement;
}

describe("Markdown", () => {
  it("renders a GitHub alert as a callout of its kind", () => {
    const el = html("> [!WARNING]\n> Back up first.\n>\n> Twice.");
    const callout = el.querySelector(".ob-callout");
    expect(callout).toHaveAttribute("data-callout", "warning");
    expect(callout?.querySelectorAll("p")).toHaveLength(2);
    expect(callout?.textContent).toContain("Back up first.");
    expect(callout?.textContent).not.toContain("[!WARNING]");
    expect(el.querySelector("blockquote")).toBeNull();
  });

  it("renders each alert kind, with the marker on its own line or not", () => {
    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      for (const source of [`> [!${kind.toUpperCase()}]\n> text`, `> [!${kind.toUpperCase()}]\n>\n> text`]) {
        const callout = html(source).querySelector(`.ob-callout[data-callout="${kind}"]`);
        expect(callout).not.toBeNull();
        expect(callout?.textContent?.trim()).toBe("text");
      }
    }
  });

  it("leaves an ordinary quote a quote", () => {
    const el = html("> just a quote");
    expect(el.querySelector("blockquote")).not.toBeNull();
    expect(el.querySelector(".ob-callout")).toBeNull();
  });

  it("renders a table with a header row", () => {
    const el = html("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    expect([...el.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["A", "B"]);
    expect([...el.querySelectorAll("tbody td")].map((c) => c.textContent)).toEqual(["1", "2", "3", "4"]);
  });

  it("keeps the start number of an ordered list", () => {
    const el = html("5. five\n6. six\n7. seven");
    expect(el.querySelector("ol")).toHaveAttribute("start", "5");
    expect(el.querySelector("ol")).not.toBeNull();
  });

  it("renders task items as read-only checkboxes that survive the sanitizer", () => {
    const el = html("- [ ] open\n- [x] done");
    const boxes = [...el.querySelectorAll(".ob-check")];
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(el.querySelector("input")).toBeNull();
  });

  it("still sanitizes", () => {
    const out = renderMarkdown("> [!NOTE]\n> <img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n<script>alert(1)</script>");
    expect(out).not.toMatch(/onerror|javascript:|<script/i);
    expect(out).toContain("ob-callout");
  });

  it("previews callouts and tables as words", () => {
    expect(markdownToText("> [!TIP]\n> Try this\n\n| A | B |\n| - | - |\n| 1 | 2 |")).toMatch(/Try this/);
  });
});

describe("Markdown mentions", () => {
  it("renders @[Name](usrXXXX) as a chip, not a link", () => {
    const html = renderMarkdown("Hi @[Ada <b>](usr1) and [a link](https://x.test)");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const chip = doc.querySelector(".ob-mention")!;
    expect(chip.tagName).toBe("SPAN");
    expect(chip.textContent).toBe("@Ada <b>");
    expect(chip.getAttribute("data-mention")).toBe("usr1");
    expect(doc.querySelectorAll("a")).toHaveLength(1);
    expect(markdownToText("Hi @[Ada](usr1)!").trim()).toBe("Hi @Ada!");
  });

  it("leaves look-alikes alone: code, escaped brackets, other ids", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("`@[Ada](usr1)` @\\[Ada\\](usr1) @[Rec](rec1)"), "text/html");
    expect(doc.querySelector(".ob-mention")).toBeNull();
    expect(doc.querySelector("code")?.textContent).toBe("@[Ada](usr1)");
  });
});
