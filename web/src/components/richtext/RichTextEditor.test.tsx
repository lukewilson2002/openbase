import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "./RichTextEditor";

function Host({ initial = "", onMarkdown }: { initial?: string; onMarkdown: (md: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <RichTextEditor
      value={value}
      onChange={(md) => {
        setValue(md);
        onMarkdown(md);
      }}
      aria-label="Notes"
      placeholder="Write something…"
    />
  );
}

const editorOf = (root: ParentNode = document) => (root.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;

describe("RichTextEditor", () => {
  it("shows the Markdown it is given as formatting, with no raw Markdown on screen", async () => {
    render(<Host initial={"# Title\n\n**bold** and a [link](https://example.com)\n\n- one\n- two"} onMarkdown={vi.fn()} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    expect(box.querySelector("h1")).toHaveTextContent("Title");
    expect(box.querySelector("strong")).toHaveTextContent("bold");
    expect(box.querySelector("a")).toHaveAttribute("href", "https://example.com");
    expect(box.querySelectorAll("li")).toHaveLength(2);
    expect(box.textContent).not.toMatch(/[#*[\]]/);
  });

  it("has the toolbar the owner asked for, each control named", async () => {
    render(<Host onMarkdown={vi.fn()} />);
    const bar = await screen.findByRole("toolbar", { name: "Formatting" });
    const names = within(bar)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Text style", "Bold", "Italic", "Strikethrough", "Code", "Link", "Bulleted list", "Numbered list", "Task list", "Indent", "Outdent", "Quote", "Callout", "Code block", "Table", "Horizontal rule"]);
  });

  it("reports Markdown from toolbar buttons and keeps the editor focused", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial="word" onMarkdown={onMarkdown} />);
    const box = await screen.findByRole("textbox", { name: "Notes" });
    act(() => editorOf().commands.selectAll());
    await userEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("**word**");
    await userEvent.click(screen.getByRole("button", { name: "Bulleted list" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("- **word**");
    expect(box).toHaveFocus();
  });

  it("picks a heading level from the text style menu", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial="word" onMarkdown={onMarkdown} />);
    await screen.findByRole("textbox", { name: "Notes" });
    await userEvent.click(screen.getByRole("button", { name: "Text style" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Heading 3" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("### word");
    expect(screen.getByRole("button", { name: "Text style" })).toHaveTextContent("Heading 3");
  });

  it("makes a callout of a chosen kind and changes its kind", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial="careful" onMarkdown={onMarkdown} />);
    await screen.findByRole("textbox", { name: "Notes" });
    await userEvent.click(screen.getByRole("button", { name: "Callout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Warning" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("> [!WARNING]\n> careful");
    expect(document.querySelector('.ob-callout[data-callout="warning"]')).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Callout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Tip" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("> [!TIP]\n> careful");
    await userEvent.click(screen.getByRole("button", { name: "Callout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove callout" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("careful");
  });

  it("inserts a table, then offers row and column actions while the cursor is in it", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial="x" onMarkdown={onMarkdown} />);
    await screen.findByRole("textbox", { name: "Notes" });
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Insert table/ }));
    expect(document.querySelectorAll(".ProseMirror table th")).toHaveLength(3);
    expect(document.querySelectorAll(".ProseMirror table td")).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    expect(items).toEqual(["Add row above", "Add row below", "Add column before", "Add column after", "Turn header row off", "Delete row", "Delete column", "Delete table"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add column after" }));
    expect(document.querySelectorAll(".ProseMirror table th")).toHaveLength(4);
  });

  it("adds a link from the popover, adding https:// to a bare address and refusing unsafe ones", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial="go here" onMarkdown={onMarkdown} />);
    await screen.findByRole("textbox", { name: "Notes" });
    act(() => editorOf().commands.setTextSelection({ from: 4, to: 8 }));
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    const input = await screen.findByLabelText("Link address");
    await userEvent.type(input, "javascript:alert(1){Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/web address/);
    expect(onMarkdown).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "example.com/a{Enter}");
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("go [here](https://example.com/a)"));
    // The same button now removes it.
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(onMarkdown).toHaveBeenLastCalledWith("go here"));
  });

  it("indents and outdents a list item from the toolbar, and says when it cannot", async () => {
    const onMarkdown = vi.fn();
    render(<Host initial={"- a\n- b"} onMarkdown={onMarkdown} />);
    await screen.findByRole("textbox", { name: "Notes" });
    act(() => editorOf().commands.setTextSelection(editorOf().state.doc.content.size - 2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Indent" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Outdent" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Indent" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("- a\n  - b");
    await userEvent.click(screen.getByRole("button", { name: "Outdent" }));
    expect(onMarkdown).toHaveBeenLastCalledWith("- a\n- b");
  });

  it("follows a value that changes from outside without reporting it as an edit", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichTextEditor value="one" onChange={onChange} aria-label="Notes" />);
    await screen.findByRole("textbox", { name: "Notes" });
    rerender(<RichTextEditor value="# two" onChange={onChange} aria-label="Notes" />);
    await waitFor(() => expect(document.querySelector(".ProseMirror h1")).toHaveTextContent("two"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the same editor full screen and Done returns to the box", async () => {
    render(<Host initial="shared" onMarkdown={vi.fn()} />);
    await screen.findByRole("textbox", { name: "Notes" });
    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    const dialog = await screen.findByRole("dialog", { name: "Notes" });
    expect(within(dialog).getByRole("textbox", { name: "Notes" })).toHaveTextContent("shared");
    act(() => editorOf(dialog).commands.insertContentAt(7, " and more"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Notes" })).toHaveTextContent("shared and more"));
  });

  it("is one Tab stop: Tab lands in the text, Alt+F10 reaches the toolbar, arrows move along it, Escape goes back", async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Before" />
        <Host initial="Hello" onMarkdown={vi.fn()} />
      </>,
    );
    const text = await screen.findByRole("textbox", { name: "Notes" });
    screen.getByRole("textbox", { name: "Before" }).focus();
    await user.tab();
    expect(text).toHaveFocus();
    // No control of the toolbar is in the Tab order.
    for (const b of within(screen.getByRole("toolbar", { name: "Formatting" })).getAllByRole("button")) expect(b).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{Alt>}{F10}{/Alt}");
    expect(screen.getByRole("button", { name: "Text style" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Bold" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(text).toHaveFocus();
  });
});
