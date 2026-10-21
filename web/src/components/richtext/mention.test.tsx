import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { normalizeMarkdown } from "./extensions";
import { RichTextEditor } from "./RichTextEditor";

const PEOPLE = [
  { id: "usr1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "usr2", name: "Grace Hopper", email: "grace@example.com" },
  { id: "usr3", name: "Alan Turing", email: "alan@example.com" },
];

function Host({ initial = "", onMarkdown, people = PEOPLE }: { initial?: string; onMarkdown: (md: string) => void; people?: typeof PEOPLE }) {
  const [value, setValue] = useState(initial);
  return (
    <RichTextEditor
      value={value}
      onChange={(md) => {
        setValue(md);
        onMarkdown(md);
      }}
      people={people}
      aria-label="Notes"
    />
  );
}

async function setup(initial = "") {
  const onMarkdown = vi.fn();
  render(<Host initial={initial} onMarkdown={onMarkdown} />);
  const box = await screen.findByRole("textbox", { name: "Notes" });
  const editor = (box as HTMLElement & { editor: Editor }).editor;
  act(() => box.focus());
  /** Types at the end of the document (jsdom has no real typing in a contenteditable). */
  const type = (text: string) => act(() => void editor.chain().focus("end").insertContent(text).run());
  return { box, editor, type, onMarkdown };
}

const picker = () => screen.queryByRole("listbox", { name: "People to mention" });
const optionNames = () => within(picker()!).getAllByRole("option").map((o) => o.textContent);

describe("mentions in the rich text editor", () => {
  it("reads and writes @[Name](usrXXXX) as a chip", () => {
    const md = "Ping @[Ada Lovelace](usr1), and @[Grace Hopper](usr2)!";
    expect(normalizeMarkdown(md)).toBe(md);
    // A mention is a whole: it carries no formatting of its own.
    expect(normalizeMarkdown("**@[Ada](usr1)** and *text*")).toBe("@[Ada](usr1) and *text*");
    // Escaped brackets are text, as typed; code is code.
    expect(normalizeMarkdown("@\\[Ada\\](usr1) `@[Ada](usr1)`")).toBe("@\\[Ada\\](usr1) `@[Ada](usr1)`");
  });

  it("shows mentions as chips", async () => {
    const { box } = await setup("Hi @[Ada Lovelace](usr1)!");
    const chip = box.querySelector(".ob-mention");
    expect(chip).toHaveTextContent("@Ada Lovelace");
    expect(chip).toHaveAttribute("data-mention", "usr1");
  });

  it("offers people after @, filters as the name is typed and picks with Enter", async () => {
    const { box, type, onMarkdown } = await setup("Hello");
    expect(picker()).not.toBeInTheDocument();
    type(" @");
    expect(optionNames()).toEqual([expect.stringContaining("Ada Lovelace"), expect.stringContaining("Grace Hopper"), expect.stringContaining("Alan Turing")]);
    expect(box).toHaveAttribute("aria-expanded", "true");
    type("a");
    // Names containing "a", emails starting with it.
    expect(optionNames()).toEqual([expect.stringContaining("Ada Lovelace"), expect.stringContaining("Grace Hopper"), expect.stringContaining("Alan Turing")]);
    type("l");
    expect(optionNames()).toEqual([expect.stringContaining("Alan Turing")]);
    await userEvent.keyboard("{Enter}");
    expect(picker()).not.toBeInTheDocument();
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(onMarkdown).toHaveBeenLastCalledWith("Hello @[Alan Turing](usr3)");
    // Typing goes on after the chip and its space.
    type("thanks");
    expect(onMarkdown).toHaveBeenLastCalledWith("Hello @[Alan Turing](usr3) thanks");
  });

  it("moves through the list with the arrows and picks with Tab or a click", async () => {
    const { box, type, onMarkdown } = await setup();
    type("@");
    await userEvent.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).toBe(within(picker()!).getAllByRole("option")[1]!.id);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(within(picker()!).getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Tab}");
    expect(onMarkdown).toHaveBeenLastCalledWith("@[Alan Turing](usr3)");
    type("and @gr");
    await userEvent.click(within(picker()!).getByRole("button", { name: /Grace Hopper/ }));
    expect(onMarkdown).toHaveBeenLastCalledWith("@[Alan Turing](usr3) and @[Grace Hopper](usr2)");
  });

  it("closes on Escape, without closing anything around it, until the @ is typed again", async () => {
    const { type } = await setup();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    type("@a");
    expect(picker()).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(picker()).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    type("d");
    expect(picker()).not.toBeInTheDocument();
    type(" @");
    expect(picker()).toBeInTheDocument();
    document.removeEventListener("keydown", outer);
  });

  it("leaves Enter to the editor when nobody matches, and offers nothing mid-word or in code", async () => {
    const { editor, type, onMarkdown } = await setup();
    type("@zzz");
    expect(picker()).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(editor.state.doc.childCount).toBe(2));
    type("mail@ad");
    expect(picker()).not.toBeInTheDocument();
    act(() => void editor.chain().focus("end").toggleCode().insertContent(" @ad").run());
    expect(picker()).not.toBeInTheDocument();
    expect(onMarkdown).toHaveBeenLastCalledWith("@zzz\n\nmail@ad `@ad`");
  });
});
