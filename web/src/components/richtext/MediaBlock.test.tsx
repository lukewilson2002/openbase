import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentRef } from "@/api/types";
import { ApiError } from "@/api/client";
import { ToastProvider } from "@/components/ui/toast";
import { richTextExtensions } from "./extensions";
import { RichTextEditor, type RichTextEditorProps } from "./RichTextEditor";

const editorOf = (root: ParentNode = document) => (root.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;

function Host({ initial = "", onMarkdown, upload }: { initial?: string; onMarkdown: (md: string) => void; upload?: RichTextEditorProps["upload"] }) {
  const [value, setValue] = useState(initial);
  return (
    <ToastProvider>
      <RichTextEditor
        value={value}
        onChange={(md) => {
          setValue(md);
          onMarkdown(md);
        }}
        upload={upload}
        aria-label="Notes"
      />
    </ToastProvider>
  );
}

const ref = (id: string, filename: string): AttachmentRef => ({ id, filename, mime: "application/octet-stream", size: 3 });
const png = (name = "photo.png") => new File(["png"], name, { type: "image/png" });

/** Selects the first media block, the way a click on it does. */
function selectBlock(): void {
  const e = editorOf();
  let at = -1;
  e.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === "media") at = pos;
  });
  act(() => e.commands.setNodeSelection(at));
}

const MIXED = [
  '![A red door](/api/attachments/att_1/door.png "The front door")',
  '![Tour](/api/attachments/att_2/tour.mp4 "Walk-through")',
  "![](/api/attachments/att_3/memo.m4a)",
  '![Q3](/api/attachments/att_4/Q3%20report.pdf "The numbers")',
].join("\n\n");

describe("media block in the editor", () => {
  it("shows an image, a video, an audio file and a file card, each with its caption", async () => {
    render(<Host initial={MIXED} onMarkdown={vi.fn()} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    const blocks = [...box.querySelectorAll("figure.ob-media")];
    expect(blocks.map((b) => b.getAttribute("data-kind"))).toEqual(["image", "video", "audio", "file"]);

    const image = blocks[0]!.querySelector("img")!;
    expect(image).toHaveAttribute("src", "/api/attachments/att_1/door.png");
    expect(image).toHaveAttribute("alt", "A red door");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(within(blocks[0] as HTMLElement).getByRole("textbox", { name: "Caption" })).toHaveValue("The front door");

    const video = blocks[1]!.querySelector("video")!;
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(blocks[2]!.querySelector("audio")).toHaveAttribute("controls");

    const card = blocks[3]!.querySelector(".ob-file")!;
    expect(card).toHaveTextContent("Q3 report.pdf");
    const download = within(card as HTMLElement).getByRole("link", { name: "Download" });
    expect(download).toHaveAttribute("href", "/api/attachments/att_4/Q3%20report.pdf");
    expect(download).toHaveAttribute("download", "Q3 report.pdf");
    // An empty caption has no input until the block is selected.
    expect(within(blocks[2] as HTMLElement).queryByRole("textbox", { name: "Caption" })).toBeNull();
  });

  it("is reachable: a selected block can be edited, Backspace removes it", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial={"before\n\n![](/api/attachments/att_1/door.png)\n\nafter"} onMarkdown={onMarkdown} />);
    await screen.findByRole("textbox", { name: "Notes" });
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    selectBlock();
    expect(await screen.findByRole("button", { name: "Alt text" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Caption" })).toBeInTheDocument();
    // The keyboard's Backspace on a selected node.
    fireEvent.keyDown(editorOf().view.dom, { key: "Backspace", keyCode: 8 });
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("before\n\nafter"));
  });

  it("edits the caption, the alt text, and removes the block", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial="![](/api/attachments/att_1/door.png)" onMarkdown={onMarkdown} />);
    await screen.findByRole("textbox", { name: "Notes" });
    selectBlock();
    await userEvent.type(await screen.findByRole("textbox", { name: "Caption" }), "The door");
    expect(onMarkdown).toHaveBeenLastCalledWith('![](/api/attachments/att_1/door.png "The door")');

    await userEvent.click(screen.getByRole("button", { name: "Alt text" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Alt text" }), "A red door{Enter}");
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith('![A red door](/api/attachments/att_1/door.png "The door")'));
    expect(document.querySelector("figure.ob-media img")).toHaveAttribute("alt", "A red door");

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith(""));
    expect(document.querySelector("figure.ob-media")).toBeNull();
  });

  it("shows nothing editable in a read-only editor", async () => {
    function ReadOnly() {
      const editor = useEditor({ extensions: richTextExtensions(), content: MIXED, contentType: "markdown", editable: false });
      return <EditorContent editor={editor} />;
    }
    render(<ReadOnly />);
    await waitFor(() => expect(document.querySelectorAll("figure.ob-media")).toHaveLength(4));
    editorOf(); // mounted
    act(() => editorOf().commands.setNodeSelection(0));
    expect(screen.queryByRole("textbox", { name: "Caption" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Alt text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText("The front door").tagName).toBe("FIGCAPTION");
  });

  it("shows the file card when an image cannot be loaded", async () => {
    render(<Host initial="![](/api/attachments/att_1/gone.png)" onMarkdown={vi.fn()} />);
    const image = (await screen.findByRole("textbox", { name: "Notes" })).querySelector("img")!;
    fireEvent.error(image);
    await waitFor(() => expect(document.querySelector("figure.ob-media .ob-file")).toHaveTextContent("gone.png"));
  });
});

describe("adding media", () => {
  it("has an Insert media button only with an upload function", async () => {
    const { unmount } = render(<Host onMarkdown={vi.fn()} />);
    await screen.findByRole("toolbar", { name: "Formatting" });
    expect(screen.queryByRole("button", { name: "Insert media" })).toBeNull();
    unmount();
    render(<Host onMarkdown={vi.fn()} upload={vi.fn()} />);
    await screen.findByRole("toolbar", { name: "Formatting" });
    expect(screen.getByRole("button", { name: "Insert media" })).toBeInTheDocument();
  });

  it("uploads picked files and inserts a block for each, with a placeholder meanwhile", async () => {
    const onMarkdown = vi.fn();
    const pending: ((r: AttachmentRef) => void)[] = [];
    const upload = vi.fn((file: File) => new Promise<AttachmentRef>((resolve) => pending.push((r) => resolve(r))).then((r) => ({ ...r, filename: file.name })));
    render(<Host initial="Intro" onMarkdown={onMarkdown} upload={upload} />);
    await screen.findByRole("textbox", { name: "Notes" });
    act(() => editorOf().commands.focus("end"));

    await userEvent.upload(screen.getByLabelText("Media files"), [png("My Photo.png"), new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    expect(upload).toHaveBeenCalledTimes(1);
    const placeholders = await screen.findAllByRole("status");
    expect(placeholders.map((p) => p.textContent)).toEqual(["Uploading My Photo.png…", "Uploading notes.pdf…"]);
    // The document does not hold half a block.
    expect(onMarkdown).not.toHaveBeenCalled();

    await act(async () => pending[0]!(ref("att_9", "x")));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("Intro\n\n![](/api/attachments/att_9/My%20Photo.png)"));
    await act(async () => pending[1]!(ref("att_10", "x")));
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("Intro\n\n![](/api/attachments/att_9/My%20Photo.png)\n\n![](/api/attachments/att_10/notes.pdf)"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelectorAll("figure.ob-media")).toHaveLength(2);
  });

  it("puts a block into an empty line instead of leaving it empty above", async () => {
    const onMarkdown = vi.fn();
    render(<Host onMarkdown={onMarkdown} upload={async () => ref("att_1", "a.png")} />);
    await screen.findByRole("textbox", { name: "Notes" });
    await userEvent.upload(screen.getByLabelText("Media files"), png("a.png"));
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("![](/api/attachments/att_1/a.png)"));
    // Something is left to type in after it.
    expect(editorOf().state.doc.lastChild?.type.name).toBe("paragraph");
  });

  it("removes the placeholder and says why when an upload fails", async () => {
    const onMarkdown = vi.fn();
    const upload = vi.fn().mockRejectedValueOnce(new ApiError(413, "too_large", "File is too large")).mockResolvedValueOnce(ref("att_2", "ok.png"));
    render(<Host initial="Intro" onMarkdown={onMarkdown} upload={upload} />);
    await screen.findByRole("textbox", { name: "Notes" });
    await userEvent.upload(screen.getByLabelText("Media files"), [png("big.png"), png("ok.png")]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("big.png was not added");
    expect(alert).toHaveTextContent("File is too large");
    // The rest still goes up.
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("Intro\n\n![](/api/attachments/att_2/ok.png)"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelectorAll("figure.ob-media")).toHaveLength(1);
  });

  it("inserts pasted files, one block each", async () => {
    const onMarkdown = vi.fn();
    const upload = vi.fn(async (file: File) => ref(`att_${file.name.length}`, file.name));
    render(<Host initial="Intro" onMarkdown={onMarkdown} upload={upload} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    act(() => editorOf().commands.focus("end"));
    fireEvent.paste(box, { clipboardData: { files: [png("a.png")], getData: () => "", types: ["Files"] } });
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("Intro\n\n![](/api/attachments/att_5/a.png)"));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("leaves a paste of a table (text with a picture of it) to the editor", async () => {
    const upload = vi.fn();
    render(<Host onMarkdown={vi.fn()} upload={upload} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    fireEvent.paste(box, { clipboardData: { files: [png("table.png")], getData: (t: string) => (t === "text/plain" ? "a\tb" : ""), types: ["Files", "text/plain"] } });
    expect(upload).not.toHaveBeenCalled();
  });

  it("ignores pasted files without an upload function", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial="Intro" onMarkdown={onMarkdown} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    fireEvent.paste(box, { clipboardData: { files: [png("a.png")], getData: () => "", types: ["Files"] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(onMarkdown).not.toHaveBeenCalled();
    expect(document.querySelector("figure.ob-media")).toBeNull();
  });

  it("inserts dropped files where they land, and ignores drops without an upload function", async () => {
    const onMarkdown = vi.fn();
    const upload = vi.fn(async (file: File) => ref("att_7", file.name));
    const { unmount } = render(<Host initial={"first\n\nsecond"} onMarkdown={onMarkdown} upload={upload} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    // jsdom has no layout: say that the drop landed in the first paragraph.
    vi.spyOn(editorOf().view, "posAtCoords").mockReturnValue({ pos: 3, inside: 0 });
    fireEvent.drop(box, { dataTransfer: { files: [png("d.png")], getData: () => "", types: ["Files"] } });
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("first\n\n![](/api/attachments/att_7/d.png)\n\nsecond"));
    unmount();

    const quiet = vi.fn();
    render(<Host initial="first" onMarkdown={quiet} />);
    const plain = await screen.findByRole("textbox", { name: "Notes" });
    vi.spyOn(editorOf().view, "posAtCoords").mockReturnValue({ pos: 1, inside: 0 });
    fireEvent.drop(plain, { dataTransfer: { files: [png("d.png")], getData: () => "", types: ["Files"] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(quiet).not.toHaveBeenCalled();
  });

  it("never makes an embed of a pasted image address", async () => {
    const onMarkdown = vi.fn();
    render(<Host onMarkdown={onMarkdown} upload={vi.fn()} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    fireEvent.paste(box, { clipboardData: { files: [], getData: (t: string) => (t === "text/plain" ? "https://evil.test/a.png" : t === "text/html" ? '<img src="https://evil.test/a.png">' : ""), types: ["text/plain", "text/html"] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("img, figure.ob-media")).toBeNull();
    if (onMarkdown.mock.calls.length > 0) expect(onMarkdown.mock.calls.at(-1)![0]).not.toMatch(/!\[/);
  });
});
