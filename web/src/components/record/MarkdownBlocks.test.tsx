/** Embed blocks (REC-6) in the Markdown renderer: static boxes where nothing is alive, and never HTML made of the block's text. */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormatCtx } from "@/lib/cells/format";
import { ShareProvider } from "@/public/view/ShareContext";
import { Markdown, markdownToText, renderMarkdown } from "./Markdown";

const FIELD = "fldAbCdEfGhIjKl";
const VIEW = "viwAbCdEfGhIjKl";
const linked = `{"embed":"linked","field":"${FIELD}"}`;
const view = `{"embed":"view","view":"${VIEW}","limit":10}`;
const block = (body: string, info = "openbase") => `\`\`\`${info}\n${body}\n\`\`\``;

function html(source: string): HTMLElement {
  const { container } = render(<Markdown source={source} />);
  return container.firstElementChild as HTMLElement;
}

afterEach(() => vi.unstubAllGlobals());

describe("embed blocks in rendered Markdown", () => {
  it("shows a readable embed as a static Embedded view box, with none of the block's text", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const body of [linked, view]) {
      const el = html(`before\n\n${block(body)}\n\nafter`);
      const box = el.querySelector(".ob-embed")!;
      expect(box).toHaveTextContent("Embedded view");
      expect(box).toHaveAttribute("role", "note");
      expect(el.textContent).not.toContain(FIELD);
      expect(el.textContent).not.toContain(VIEW);
      expect(el.querySelector("pre, code")).toBeNull();
      expect(el.querySelectorAll("p")).toHaveLength(2);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows a block that does not read as a muted box that cannot be shown", () => {
    for (const body of ["not json {", `{"embed":"linked","field":"${FIELD}","extra":1}`, `{"embed":"linked","field":"nope"}`, "<img src=x onerror=alert(1)>"]) {
      const el = html(block(body));
      expect(el.querySelector(".ob-embed-unreadable"), body).toHaveTextContent("This embed can't be shown");
      expect(el.querySelector("img"), body).toBeNull();
    }
    // An info string with more than the one word is not a readable embed either, but is still an embed block.
    expect(html(block(linked, "openbase more")).querySelector(".ob-embed-unreadable")).not.toBeNull();
  });

  it("leaves other code blocks alone, whatever they hold", () => {
    const el = html(block(linked, "json"));
    expect(el.querySelector("pre code")).toHaveTextContent(linked);
    expect(el.querySelector(".ob-embed")).toBeNull();
    expect(html("```\nplain\n```").querySelector("pre code")).toHaveTextContent("plain");
  });

  it("makes no HTML of the text: a script-like body is not rendered and not echoed", () => {
    const el = html(block(`{"embed":"linked","field":"</div><script>alert(1)</script>"}`));
    expect(el.querySelector("script")).toBeNull();
    expect(el.innerHTML).not.toContain("alert(1)");
  });

  it("shows the same box on a shared page, and fetches nothing there", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(
      <ShareProvider value={{ token: "tok", password: null, format: {} as FormatCtx }}>
        <Markdown source={block(view)} />
      </ShareProvider>,
    );
    expect(container.querySelector(".ob-embed")).toHaveTextContent("Embedded view");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks no place for a live embed unless asked, and plain renders carry no embed text", () => {
    const out = renderMarkdown(block(linked));
    expect(out).not.toContain("data-ob-embed");
    expect(out).toContain("Embedded view");
  });

  it("is not forged by HTML in the text: a place is only one the renderer made with its own secret", () => {
    const out = renderMarkdown('<div class="ob-embed" data-ob-embed="guess:0">x</div>');
    // Raw HTML survives the sanitizer as a harmless element; with no secret it is never brought to life.
    expect(out).not.toContain("Embedded view");
  });

  it("is left out of previews, which are words", () => {
    const words = (md: string) => markdownToText(md).replace(/\s+/g, " ").trim();
    expect(words(`# Plan\n\n${block(linked)}\n\nAfter`)).toBe("Plan After");
    expect(words(block("broken"))).toBe("");
  });
});
