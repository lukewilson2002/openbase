import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormatCtx } from "@/lib/cells/format";
import { ShareProvider } from "@/public/view/ShareContext";
import { Markdown, markdownToText, renderMarkdown } from "./Markdown";

function html(source: string): HTMLElement {
  const { container } = render(<Markdown source={source} />);
  return container.firstElementChild as HTMLElement;
}

const img = "/api/attachments/att_1/door.png";

afterEach(() => vi.unstubAllGlobals());

describe("Markdown embeds", () => {
  it("shows an image of ours as a figure with its caption", () => {
    const el = html(`![A red door](${img} "The front door")`);
    const figure = el.querySelector("figure.ob-media")!;
    expect(figure).toHaveAttribute("data-kind", "image");
    expect(figure.querySelector("img")).toHaveAttribute("src", img);
    expect(figure.querySelector("img")).toHaveAttribute("alt", "A red door");
    expect(figure.querySelector("img")).toHaveAttribute("loading", "lazy");
    expect(figure.querySelector("figcaption")).toHaveTextContent("The front door");
    // A block of its own, not inside a paragraph.
    expect(figure.closest("p")).toBeNull();
  });

  it("shows no caption element without a caption", () => {
    expect(html(`![](${img})`).querySelector("figcaption")).toBeNull();
  });

  it("shows a video and an audio file with controls", () => {
    const video = html("![Tour](/api/attachments/att_2/tour.mp4)").querySelector("video")!;
    expect(video).toHaveAttribute("src", "/api/attachments/att_2/tour.mp4");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).toHaveAttribute("aria-label", "Tour");
    const audio = html("![](/api/attachments/att_3/memo.m4a)").querySelector("audio")!;
    expect(audio).toHaveAttribute("src", "/api/attachments/att_3/memo.m4a");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("aria-label", "memo.m4a");
  });

  it("shows any other file as a card with a download link", () => {
    const el = html('![Q3](/api/attachments/att_4/Q3%20report.pdf "The numbers")');
    const card = el.querySelector("figure.ob-media .ob-file")!;
    expect(card.querySelector(".ob-file-name")).toHaveTextContent("Q3 report.pdf");
    const link = card.querySelector("a")!;
    expect(link).toHaveTextContent("Download");
    expect(link).toHaveAttribute("href", "/api/attachments/att_4/Q3%20report.pdf");
    expect(link).toHaveAttribute("download", "Q3 report.pdf");
    expect(el.querySelector("figcaption")).toHaveTextContent("The numbers");
  });

  it("lifts an image out of a sentence, leaving the text as paragraphs", () => {
    const el = html(`see ![x](${img}) here`);
    expect([...el.children].map((c) => c.tagName)).toEqual(["P", "FIGURE", "P"]);
    expect(el.children[0]).toHaveTextContent("see");
    expect(el.children[2]).toHaveTextContent("here");
  });

  it("turns an image from anywhere else into a plain link, with no <img> at all", () => {
    for (const src of ["https://evil.test/a.png", "http://evil.test/a.png", "//evil.test/a.png", "data:image/png;base64,AAAA", "pics/a.png", "/other/a.png", "/api/attachments/att_1/a.png?x=1"]) {
      const el = html(`![x](${src})`);
      expect(el.querySelector("img, video, audio, figure"), src).toBeNull();
    }
    const out = html("![x](https://evil.test/a.png)");
    const link = out.querySelector("a")!;
    expect(link).toHaveAttribute("href", "https://evil.test/a.png");
    expect(link).toHaveTextContent("x");
    expect(html("![](https://evil.test/a.png)").querySelector("a")).toHaveTextContent("https://evil.test/a.png");
  });

  it("never lets raw HTML fetch from anywhere but our own files", () => {
    const out = renderMarkdown(
      [
        '<img src="https://evil.test/a.png" alt="x">',
        '<video src="https://evil.test/a.mp4" controls></video>',
        '<audio src="//evil.test/a.mp3"></audio>',
        '<video controls poster="https://evil.test/p.png"><source src="https://evil.test/a.mp4"></video>',
        '<img src="/api/attachments/att_1/a.png" onerror="alert(1)">',
        '<img src="/api/attachments/../../logout">',
      ].join("\n\n"),
    );
    expect(out).not.toContain("evil.test");
    expect(out).not.toMatch(/onerror|poster|<source|logout/);
    // Media only comes from Markdown image syntax: raw HTML gets no <img> at all, even one of ours.
    expect(out).not.toMatch(/<(img|video|audio)\b/);
  });

  it("shows no media for raw HTML that spells our address in disguise", () => {
    const id = "att0123456789abcde";
    for (const source of [
      `<img src="&#47;api&#47;attachments&#47;${id}/x.png">`,
      `<img src="&#x2F;api&#x2f;attachments/${id}/x.png" alt="x">`,
      `<video src="&sol;api/attachments/${id}/x.mp4" controls></video>`,
      `<audio data-embed="/api/attachments/${id}/x.mp3" controls></audio>`,
      `<IMG SRC="/api/attachments/${id}/x.png">`,
      `<div><img src="/api/attachments/${id}/x.png"></div>`,
      `<p data-ob-media="1"><img data-ob-media="1" src="/api/attachments/${id}/x.png"></p>`,
    ]) {
      const el = html(source);
      expect(el.querySelector("img, video, audio, figure"), source).toBeNull();
    }
  });

  it("shows no media for an address that only means ours after Markdown unescapes it", () => {
    const id = "att0123456789abcde";
    for (const source of [`![](/api\\/attachments/${id}/x.png)`, `![x](/api/attachments\\/${id}/x.png "c")`, `![](/api&#47;attachments/${id}/x.png)`]) {
      const el = html(source);
      expect(el.querySelector("img, video, audio, figure"), source).toBeNull();
    }
    // The plain form is unaffected.
    expect(html(`![](/api/attachments/${id}/x.png)`).querySelector("figure img")).not.toBeNull();
  });

  it("keeps the caption and alt text from becoming markup", () => {
    const el = html(`![<b>a</b>](${img} "<i>c</i> & \\"q\\"")`);
    expect(el.querySelector("b, i")).toBeNull();
    expect(el.querySelector("img")).toHaveAttribute("alt", "<b>a</b>");
    expect(el.querySelector("figcaption")?.textContent).toBe('<i>c</i> & "q"');
  });

  it("previews an embed as its caption and the rest as words", () => {
    expect(markdownToText(`before\n\n![x](${img} "Door")\n\nafter`)).toMatch(/before\s+Door\s+after/);
  });

  describe("on a shared page", () => {
    const ctx = (password: string | null) => ({ token: "tok_s", password, format: {} as FormatCtx });
    function shared(source: string, password: string | null = null): HTMLElement {
      const { container } = render(
        <ShareProvider value={ctx(password)}>
          <Markdown source={source} />
        </ShareProvider>,
      );
      return container.firstElementChild as HTMLElement;
    }

    it("appends the share token to the address of every embed", () => {
      const el = shared(`![](${img})\n\n![](/api/attachments/att_2/t.mp4)\n\n![](/api/attachments/att_3/m.mp3)\n\n![](/api/attachments/att_4/r.pdf)`);
      expect(el.querySelector("img")).toHaveAttribute("src", `${img}?share=tok_s`);
      expect(el.querySelector("video")).toHaveAttribute("src", "/api/attachments/att_2/t.mp4?share=tok_s");
      expect(el.querySelector("audio")).toHaveAttribute("src", "/api/attachments/att_3/m.mp3?share=tok_s");
      expect(el.querySelector(".ob-file a")).toHaveAttribute("href", "/api/attachments/att_4/r.pdf?share=tok_s");
    });

    it("adds no token off a shared page", () => {
      expect(html(`![](${img})`).querySelector("img")).toHaveAttribute("src", img);
    });

    it("loads the embeds of a protected link with the password, from blob URLs", async () => {
      const calls: { url: string; password: string | null }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), password: new Headers(init?.headers).get("X-Share-Password") });
          return new Response(new Blob(["x"], { type: "image/png" }), { status: 200 });
        }),
      );
      const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:embed-1");
      const el = shared(`![](${img})`, "hunter2");
      const image = el.querySelector("img")!;
      // Nothing to be fetched without the password.
      expect(image.getAttribute("src")).toBeNull();
      await waitFor(() => expect(image).toHaveAttribute("src", "blob:embed-1"));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/api/attachments/att_1/door.png");
      expect(calls[0]!.url).toContain("share=tok_s");
      expect(calls[0]!.password).toBe("hunter2");
      create.mockRestore();
    });
  });
});
