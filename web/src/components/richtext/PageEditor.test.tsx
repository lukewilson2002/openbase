import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubDesktop, stubPhone } from "@/test/utils";
import { PageEditor, PAGE_PLACEHOLDER, type PageEditorProps } from "./PageEditor";

const PEOPLE = [{ id: "usr1", name: "Ada Lovelace", email: "ada@example.com" }];
const upload = vi.fn();

function setup(props: Partial<PageEditorProps> = {}, { phone = false, initial = "" }: { phone?: boolean; initial?: string } = {}) {
  if (phone) stubPhone();
  else stubDesktop();
  const onChange = vi.fn();
  const onBlur = vi.fn();
  render(<PageEditor value={initial} onChange={onChange} onBlur={onBlur} people={PEOPLE} embeds={{ linkFields: [], views: [] }} {...props} />);
  return { onChange, onBlur };
}

async function open(props: Partial<PageEditorProps> = {}, opts: { phone?: boolean; initial?: string } = {}) {
  const handlers = setup(props, opts);
  const box = await screen.findByRole("textbox", { name: "Page" });
  const editor = (box as HTMLElement & { editor: Editor }).editor;
  act(() => box.focus());
  /** Types at the end of the document (jsdom has no real typing in a contenteditable). */
  const type = (text: string) => act(() => void editor.chain().focus("end").insertContent(text).run());
  /** Types like a keyboard does, each character going through the input rules (the Markdown shortcuts). */
  const keys = (text: string) =>
    act(() => {
      for (const ch of text) {
        const { from, to } = editor.state.selection;
        const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
        if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
      }
    });
  const md = () => editor.getMarkdown().trim();
  return { ...handlers, box, editor, type, keys, md };
}

const menu = () => screen.queryByRole("listbox", { name: /Blocks|Link property to show|View to show/ });
const optionNames = () => within(menu()!).getAllByRole("option").map((o) => o.textContent);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PageEditor", () => {
  it("is a document: no toolbar at rest, the page's placeholder, and marked for the title's Enter to find", async () => {
    const { box } = await open();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(box).toHaveAttribute("data-record-page");
    expect(box).toHaveAttribute("aria-multiline", "true");
    expect(box.querySelector("p")).toHaveAttribute("data-placeholder", PAGE_PLACEHOLDER);
    expect(PAGE_PLACEHOLDER).toBe("Type / to add a heading, a list, a view or a property");
  });

  it("reads 15/24 on a desktop and 16/25 on a phone through the page text tokens", async () => {
    const { box } = await open();
    expect(box.className).toContain("text-read-phone");
    expect(box.className).toContain("md:text-read");
    expect(box.className).toContain("ob-prose");
  });

  it("shows the Markdown it is given and does not report a change until something is edited", async () => {
    const { box, onChange } = await open({}, { initial: "# Plan\n\n**bold** and [a link](https://example.com)\n\n- one\n- two" });
    expect(box.querySelector("h1")).toHaveTextContent("Plan");
    expect(box.querySelector("strong")).toHaveTextContent("bold");
    expect(box.querySelectorAll("li")).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  describe("Markdown shortcuts", () => {
    it.each([
      ["# ", "Title", "# Title"],
      ["## ", "Sub", "## Sub"],
      ["### ", "Small", "### Small"],
      ["- ", "item", "- item"],
      ["1. ", "first", "1. first"],
      ["[ ] ", "todo", "- [ ] todo"],
      ["> ", "quoted", "> quoted"],
      ["[!TIP] ", "careful", "> [!TIP]\n> careful"],
      ["---", "", "---"],
    ])("%s turns the line into its block", async (shortcut, text, expected) => {
      const { keys, md } = await open();
      keys(shortcut + text);
      expect(md()).toBe(expected);
    });

    it("makes bold, italic, strike and code from the marks typed around a word", async () => {
      const { keys, md } = await open();
      keys("**b** *i* ~~s~~ `c`");
      expect(md()).toBe("**b** *i* ~~s~~ `c`");
    });

    it("makes a code block from three backticks", async () => {
      const { keys, md } = await open();
      keys("``` ");
      keys("x");
      expect(md()).toBe("```\nx\n```");
    });
  });

  describe("the block menu", () => {
    it("opens on a slash in an empty block with every block, in the order of the spec, and closes when the slash is gone", async () => {
      const { editor, type } = await open({ upload });
      expect(menu()).not.toBeInTheDocument();
      type("/");
      expect(optionNames()).toEqual(
        expect.arrayContaining([expect.stringContaining("Heading 1"), expect.stringContaining("Callout"), expect.stringContaining("Image or file"), expect.stringContaining("Property")]),
      );
      expect(optionNames().map((n) => n!.replace(/[#\-[\]!A-Z.0-9` ]+$/, ""))).toHaveLength(15);
      expect(screen.getByRole("textbox", { name: "Page" })).toHaveAttribute("aria-expanded", "true");
      act(() => void editor.commands.deleteRange({ from: 1, to: 2 }));
      expect(menu()).not.toBeInTheDocument();
    });

    it("opens after a space but not inside a word or an address", async () => {
      const { type } = await open();
      type("and/or");
      expect(menu()).not.toBeInTheDocument();
      type(" see https://x.test");
      expect(menu()).not.toBeInTheDocument();
      type(" /");
      expect(menu()).toBeInTheDocument();
    });

    it("narrows as the name is typed and picks the highlighted block with Enter", async () => {
      const { type, md } = await open();
      type("/head");
      expect(optionNames().map((n) => n!.slice(0, 9))).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
      await userEvent.keyboard("{ArrowDown}{Enter}");
      expect(menu()).not.toBeInTheDocument();
      type("Subtitle");
      expect(md()).toBe("## Subtitle");
    });

    it("wraps with the arrow keys and picks with Tab too", async () => {
      const { type, md } = await open();
      type("/head");
      await userEvent.keyboard("{ArrowUp}{Tab}");
      type("Small");
      expect(md()).toBe("### Small");
    });

    it("picks with a click and keeps the focus in the text", async () => {
      const { box, type, md } = await open();
      type("/bull");
      await userEvent.click(screen.getByRole("option", { name: /Bulleted list/ }));
      type("one");
      expect(md()).toBe("- one");
      expect(box).toHaveFocus();
    });

    it("Escape closes the menu and keeps what was typed; it opens again only at a new slash", async () => {
      const { type, md } = await open();
      type("/he");
      await userEvent.keyboard("{Escape}");
      expect(menu()).not.toBeInTheDocument();
      expect(md()).toBe("/he");
      type("a");
      expect(menu()).not.toBeInTheDocument();
      type(" /");
      expect(menu()).toBeInTheDocument();
    });

    it("says nothing and shows nothing when no block matches", async () => {
      const { type } = await open();
      type("/zzz");
      expect(menu()).not.toBeInTheDocument();
    });

    it.each([
      ["Heading 1", "# x"],
      ["Heading 2", "## x"],
      ["Heading 3", "### x"],
      ["Bulleted list", "- x"],
      ["Numbered list", "1. x"],
      ["Checklist", "- [ ] x"],
      ["Quote", "> x"],
      ["Callout", "> [!NOTE]\n> x"],
      ["Code block", "```\nx\n```"],
    ])("%s makes its block where the slash was", async (name, expected) => {
      const { type, md } = await open();
      type("/");
      await userEvent.click(screen.getByRole("option", { name: new RegExp(`^${name}`) }));
      type("x");
      expect(md()).toBe(expected);
    });

    it("makes a table of three by three with a header row", async () => {
      const { type, box, md } = await open();
      type("/tab");
      await userEvent.keyboard("{Enter}");
      expect(box.querySelectorAll("table tr")).toHaveLength(3);
      expect(box.querySelectorAll("table th")).toHaveLength(3);
      expect(md()).toBe("|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |");
    });

    it("makes a divider and leaves a line to go on in", async () => {
      const { type, md, box } = await open();
      type("above");
      await userEvent.keyboard("{Enter}");
      type("/div");
      await userEvent.keyboard("{Enter}");
      type("below");
      expect(box.querySelector("hr")).toBeInTheDocument();
      expect(md()).toBe("above\n\n---\n\nbelow");
    });

    it("turns a line of text into the block, keeping the text, when the slash comes after it", async () => {
      const { type, md } = await open({}, { initial: "Plan" });
      type(" /h1");
      await userEvent.keyboard("{Enter}");
      expect(md()).toBe("# Plan");
    });

    describe("Image or file", () => {
      it("is not offered where there is nowhere to keep a file", async () => {
        const { type } = await open();
        type("/image");
        expect(menu()).not.toBeInTheDocument();
      });

      it("opens the file picker and takes the slash away", async () => {
        const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
        const { type, md } = await open({ upload });
        type("/image");
        await userEvent.keyboard("{Enter}");
        expect(click).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText("Media files")).toHaveAttribute("type", "file");
        expect(md()).toBe("");
      });
    });

    describe("Linked records and View", () => {
      const two = { linkFields: [{ id: "fld_a", name: "Invoices" }, { id: "fld_b", name: "Contacts" }], views: [{ id: "viw_a", name: "Open invoices", collection: "Invoices" }, { id: "viw_b", name: "Default grid", collection: "Contacts" }] };

      it("writes the openbase block for the link property picked in a second step", async () => {
        const { type, md } = await open({ embeds: two });
        type("/linked");
        await userEvent.keyboard("{Enter}");
        expect(screen.getByRole("listbox", { name: "Link property to show" })).toBeInTheDocument();
        expect(optionNames()).toEqual(["Invoices", "Contacts"]);
        await userEvent.keyboard("{ArrowDown}{Enter}");
        expect(menu()).not.toBeInTheDocument();
        expect(md()).toBe('```openbase\n{"embed":"linked","field":"fld_b"}\n```');
      });

      it("writes the openbase block for the saved view picked, with the collection beside each name", async () => {
        const { type, md } = await open({ embeds: two });
        type("/view");
        await userEvent.keyboard("{Enter}");
        expect(optionNames()).toEqual(["Open invoicesInvoices", "Default gridContacts"]);
        await userEvent.click(screen.getByRole("option", { name: /Open invoices/ }));
        expect(md()).toBe('```openbase\n{"embed":"view","view":"viw_a","limit":10}\n```');
      });

      it("skips the second step when there is only one to show", async () => {
        const { type, md } = await open({ embeds: { linkFields: [{ id: "fld_a", name: "Invoices" }], views: [] } });
        type("/linked");
        await userEvent.keyboard("{Enter}");
        expect(md()).toBe('```openbase\n{"embed":"linked","field":"fld_a"}\n```');
      });

      it("keeps the text around the block and a line to type on", async () => {
        const { type, md, editor } = await open({ embeds: { linkFields: [{ id: "fld_a", name: "Invoices" }], views: [] } }, { initial: "Before" });
        act(() => void editor.commands.focus("end"));
        await userEvent.keyboard("{Enter}");
        type("/linked");
        await userEvent.keyboard("{Enter}");
        type("After");
        expect(md()).toBe('Before\n\n```openbase\n{"embed":"linked","field":"fld_a"}\n```\n\nAfter');
      });

      it("lists them as unavailable, with the reason, when there is nothing to embed", async () => {
        const { type, md } = await open();
        type("/linked");
        const row = screen.getByRole("option", { name: /Linked records/ });
        expect(row).toHaveAttribute("aria-disabled", "true");
        expect(row).toHaveTextContent("This collection has no link properties");
        await userEvent.keyboard("{Enter}");
        expect(md()).toBe("/linked");
        await userEvent.click(row);
        expect(md()).toBe("/linked");
      });

      it("the second step closes on Escape and when something is typed", async () => {
        const { type, md } = await open({ embeds: two });
        type("/view");
        await userEvent.keyboard("{Enter}");
        await userEvent.keyboard("{Escape}");
        expect(menu()).not.toBeInTheDocument();
        type("/view");
        await userEvent.keyboard("{Enter}");
        type("x");
        expect(menu()).not.toBeInTheDocument();
        expect(md()).toBe("x");
      });
    });

    describe("Property", () => {
      it("opens the add property box and takes the slash away", async () => {
        const onAddProperty = vi.fn();
        const { type, md } = await open({ onAddProperty });
        type("/prop");
        await userEvent.keyboard("{Enter}");
        expect(onAddProperty).toHaveBeenCalledTimes(1);
        expect(md()).toBe("");
      });

      it("is listed but unavailable, with the reason, for someone who cannot add properties", async () => {
        const { type } = await open();
        type("/prop");
        const row = screen.getByRole("option", { name: /Property/ });
        expect(row).toHaveAttribute("aria-disabled", "true");
        expect(row).toHaveTextContent("Only creators can add properties");
      });
    });
  });

  describe("the selection bubble", () => {
    it("shows over selected text with bold, italic, strike, code and link, and not over a caret", async () => {
      const { editor } = await open({}, { initial: "some words here" });
      expect(screen.queryByRole("toolbar", { name: "Format selection" })).not.toBeInTheDocument();
      act(() => void editor.commands.setTextSelection({ from: 1, to: 5 }));
      const bar = await screen.findByRole("toolbar", { name: "Format selection" });
      expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Bold", "Italic", "Strikethrough", "Code", "Link"]);
      act(() => void editor.commands.setTextSelection(3));
      await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Format selection" })).not.toBeInTheDocument());
    });

    it("applies each mark to the selection, shows which are on, and keeps the focus in the text", async () => {
      const { editor, md, box } = await open({}, { initial: "word" });
      act(() => void editor.commands.selectAll());
      act(() => void editor.commands.setTextSelection({ from: 1, to: 5 }));
      const bar = await screen.findByRole("toolbar", { name: "Format selection" });
      await userEvent.click(within(bar).getByRole("button", { name: "Bold" }));
      expect(md()).toBe("**word**");
      expect(within(bar).getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(within(bar).getByRole("button", { name: "Italic" }));
      await userEvent.click(within(bar).getByRole("button", { name: "Strikethrough" }));
      expect(md()).toBe("***~~word~~***");
      // Code is a mark of its own: it takes the others off.
      await userEvent.click(within(bar).getByRole("button", { name: "Code" }));
      expect(md()).toBe("`word`");
      expect(box).toHaveFocus();
    });

    it("adds a link from the bubble: the address is taken as typed and the selection becomes the link", async () => {
      const { editor, md } = await open({}, { initial: "see docs now" });
      act(() => void editor.commands.setTextSelection({ from: 5, to: 9 }));
      const bar = await screen.findByRole("toolbar", { name: "Format selection" });
      await userEvent.click(within(bar).getByRole("button", { name: "Link" }));
      const input = await screen.findByLabelText("Link address");
      expect(input).toHaveFocus();
      await userEvent.type(input, "example.com/docs{Enter}");
      expect(md()).toBe("see [docs](https://example.com/docs) now");
      expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Page" })).toHaveFocus());
    });

    it("refuses an address that is not a web, mail or phone one, and says so", async () => {
      const { editor, md } = await open({}, { initial: "see docs now" });
      act(() => void editor.commands.setTextSelection({ from: 5, to: 9 }));
      await userEvent.click(within(await screen.findByRole("toolbar", { name: "Format selection" })).getByRole("button", { name: "Link" }));
      await userEvent.type(await screen.findByLabelText("Link address"), "javascript:alert(1){Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent("Use a web address");
      expect(md()).toBe("see docs now");
    });

    it("changes and removes the link under the selection", async () => {
      const { editor, md } = await open({}, { initial: "see [docs](https://old.example) now" });
      act(() => void editor.commands.setTextSelection({ from: 5, to: 9 }));
      await userEvent.click(within(await screen.findByRole("toolbar", { name: "Format selection" })).getByRole("button", { name: "Link" }));
      const input = await screen.findByLabelText("Link address");
      expect(input).toHaveValue("https://old.example");
      await userEvent.clear(input);
      await userEvent.type(input, "https://new.example{Enter}");
      expect(md()).toBe("see [docs](https://new.example) now");
      act(() => void editor.commands.setTextSelection({ from: 5, to: 9 }));
      await userEvent.click(within(await screen.findByRole("toolbar", { name: "Format selection" })).getByRole("button", { name: "Link" }));
      await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
      expect(md()).toBe("see docs now");
    });

    it("gives up on Escape, with the text focused again and nothing changed", async () => {
      const { editor, md, box } = await open({}, { initial: "see docs now" });
      act(() => void editor.commands.setTextSelection({ from: 5, to: 9 }));
      await userEvent.click(within(await screen.findByRole("toolbar", { name: "Format selection" })).getByRole("button", { name: "Link" }));
      await userEvent.type(await screen.findByLabelText("Link address"), "example.com{Escape}");
      expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();
      await waitFor(() => expect(box).toHaveFocus());
      expect(md()).toBe("see docs now");
    });
  });

  describe("Ctrl+K", () => {
    const press = (box: HTMLElement, init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...init });
      box.dispatchEvent(event);
      return event;
    };

    it("handles the key, which is how the command palette knows to yield, and opens the link form at the caret", async () => {
      const { box } = await open({}, { initial: "text" });
      const seenByWindow = vi.fn();
      window.addEventListener("keydown", seenByWindow);
      const event = press(box, { ctrlKey: true });
      window.removeEventListener("keydown", seenByWindow);
      expect(event.defaultPrevented).toBe(true);
      expect(seenByWindow.mock.calls[0]![0].defaultPrevented).toBe(true);
      expect(await screen.findByLabelText("Link address")).toHaveFocus();
    });

    it("works with Cmd+K as well", async () => {
      const { box } = await open({}, { initial: "text" });
      expect(press(box, { metaKey: true }).defaultPrevented).toBe(true);
      expect(await screen.findByLabelText("Link address")).toBeInTheDocument();
    });

    it("adds the address as linked text when nothing is selected", async () => {
      const { box, md, editor } = await open({}, { initial: "see " });
      // `focus` finishes a frame later: let it, or it takes the focus back from the form.
      await act(async () => {
        editor.commands.focus("end");
        await new Promise((r) => requestAnimationFrame(r));
      });
      press(box, { ctrlKey: true });
      await userEvent.type(await screen.findByLabelText("Link address"), "https://example.com{Enter}");
      expect(md()).toBe("see [https://example.com](https://example.com)");
    });

    it("leaves other Ctrl keys alone", async () => {
      const { box } = await open({}, { initial: "text" });
      expect(press(box, { ctrlKey: true, key: "j" }).defaultPrevented).toBe(false);
      // A shifted K is a capital one.
      expect(press(box, { ctrlKey: true, shiftKey: true, key: "K" }).defaultPrevented).toBe(false);
    });
  });

  describe("on a phone", () => {
    it("has no bubble, and a formatting bar above the keyboard while the page has focus", async () => {
      const { box, editor } = await open({}, { phone: true, initial: "word" });
      const bar = await screen.findByRole("toolbar", { name: "Formatting" });
      expect(bar.closest(".fixed")).toBeInTheDocument();
      expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
        "Add block",
        "Bold",
        "Italic",
        "Strikethrough",
        "Code",
        "Link",
        "Bulleted list",
        "Numbered list",
        "Checklist",
        "Indent",
        "Outdent",
        "Hide keyboard",
      ]);
      act(() => void editor.commands.setTextSelection({ from: 1, to: 5 }));
      expect(screen.queryByRole("toolbar", { name: "Format selection" })).not.toBeInTheDocument();
      expect(box).toHaveFocus();
    });

    it("is gone when the page does not have the focus", async () => {
      const { box } = await open({}, { phone: true });
      await screen.findByRole("toolbar", { name: "Formatting" });
      act(() => box.blur());
      await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument());
    });

    it("formats without moving the focus, and Hide keyboard puts it away", async () => {
      const { box, editor, md } = await open({}, { phone: true, initial: "word" });
      const bar = await screen.findByRole("toolbar", { name: "Formatting" });
      act(() => void editor.commands.setTextSelection({ from: 1, to: 5 }));
      await userEvent.click(within(bar).getByRole("button", { name: "Bold" }));
      await userEvent.click(within(bar).getByRole("button", { name: "Bulleted list" }));
      expect(md()).toBe("- **word**");
      expect(box).toHaveFocus();
      await userEvent.click(within(bar).getByRole("button", { name: "Hide keyboard" }));
      await waitFor(() => expect(box).not.toHaveFocus());
    });

    it("indents and outdents a list item, since the keyboard has no Tab", async () => {
      const { editor, md } = await open({}, { phone: true, initial: "- one\n- two" });
      const bar = await screen.findByRole("toolbar", { name: "Formatting" });
      expect(within(bar).getByRole("button", { name: "Indent" })).toBeDisabled();
      act(() => void editor.commands.setTextSelection(editor.state.doc.content.size - 3));
      await userEvent.click(await waitFor(() => within(bar).getByRole("button", { name: "Indent", hidden: false })));
      expect(md()).toBe("- one\n  - two");
      await userEvent.click(within(bar).getByRole("button", { name: "Outdent" }));
      expect(md()).toBe("- one\n- two");
    });

    it("Add block opens the block menu docked on the bar, and a choice makes the block at the caret", async () => {
      const { md, type } = await open({}, { phone: true });
      type("Plan");
      const bar = await screen.findByRole("toolbar", { name: "Formatting" });
      await userEvent.click(within(bar).getByRole("button", { name: "Add block" }));
      const list = await screen.findByRole("listbox", { name: "Blocks" });
      expect(list.closest(".fixed")).toBeInTheDocument();
      expect(within(list).getAllByRole("option")).toHaveLength(14);
      await userEvent.click(within(list).getByRole("option", { name: /Heading 1/ }));
      expect(md()).toBe("# Plan");
      expect(screen.queryByRole("listbox", { name: "Blocks" })).not.toBeInTheDocument();
    });

    it("types a slash into the same docked menu", async () => {
      const { type } = await open({}, { phone: true });
      type("/");
      const list = await screen.findByRole("listbox", { name: "Blocks" });
      expect(list.closest(".fixed")).toBeInTheDocument();
    });

    it("takes the link address in the bar", async () => {
      const { md, editor } = await open({}, { phone: true, initial: "see docs now" });
      act(() => void editor.commands.setTextSelection({ from: 5, to: 9 }));
      await userEvent.click(within(await screen.findByRole("toolbar", { name: "Formatting" })).getByRole("button", { name: "Link" }));
      const input = await screen.findByLabelText("Link address");
      expect(input.closest(".fixed")).toBeInTheDocument();
      await userEvent.type(input, "example.com{Enter}");
      expect(md()).toBe("see [docs](https://example.com) now");
    });
  });
});
