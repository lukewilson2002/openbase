import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { richTextExtensions } from "./extensions";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(md = ""): Editor {
  editor = new Editor({ element: document.createElement("div"), extensions: richTextExtensions(), content: md, contentType: "markdown" });
  return editor;
}

/** Types like a keyboard does: each character goes through the input rules before it is inserted. */
function type(e: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = e.state.selection;
    const handled = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)));
    if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to));
  }
}

const md = (e: Editor) => e.getMarkdown().trim();

/** Presses a key as the browser would, and answers whether the editor took it (the browser's own action, such as moving the focus, would not happen). */
function press(e: Editor, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  e.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("rich text editing", () => {
  it("turns Markdown typed as shortcuts into formatting", () => {
    const e = make();
    type(e, "# Title");
    e.commands.enter();
    type(e, "- one");
    e.commands.enter();
    type(e, "two");
    e.commands.enter();
    e.commands.enter();
    type(e, "**bold** and *it*");
    expect(md(e)).toBe("# Title\n\n- one\n- two\n\n**bold** and *it*");
  });

  it("starts a numbered list at the number typed and keeps counting", () => {
    const e = make();
    type(e, "5. five");
    e.commands.enter();
    type(e, "six");
    e.commands.enter();
    type(e, "seven");
    expect(md(e)).toBe("5. five\n6. six\n7. seven");
    expect(e.getJSON().content?.[0]?.attrs?.start).toBe(5);
  });

  it("wraps a quote, a task item and a callout from their shortcuts", () => {
    const e = make();
    type(e, "> quoted");
    expect(md(e)).toBe("> quoted");
    e.commands.clearContent();
    type(e, "[ ] todo");
    expect(md(e)).toBe("- [ ] todo");
    e.commands.clearContent();
    type(e, "[!TIP] try it");
    expect(md(e)).toBe("> [!TIP]\n> try it");
  });

  it("indents and outdents list items", () => {
    const e = make("- a\n- b");
    e.commands.setTextSelection(e.state.doc.content.size - 2);
    expect(e.commands.sinkListItem("listItem")).toBe(true);
    expect(md(e)).toBe("- a\n  - b");
    expect(e.commands.liftListItem("listItem")).toBe(true);
    expect(md(e)).toBe("- a\n- b");
  });

  it("changes the kind of a callout and removes it", () => {
    const e = make("> [!NOTE]\n> hi");
    e.commands.setTextSelection(3);
    e.commands.setCallout("caution");
    expect(md(e)).toBe("> [!CAUTION]\n> hi");
    e.commands.unsetCallout();
    expect(md(e)).toBe("hi");
    e.commands.setCallout("warning");
    expect(md(e)).toBe("> [!WARNING]\n> hi");
  });

  it("edits a table: insert, add and remove rows and columns, header row", () => {
    const e = make("text");
    e.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    expect(md(e)).toBe("|     |     |\n| --- | --- |\n|     |     |\n\ntext");
    e.commands.addColumnAfter();
    e.commands.addRowAfter();
    expect(md(e).split("\n").filter((l) => l.startsWith("|"))).toHaveLength(4); // header, rule, two body rows
    expect(md(e).split("\n")[1]).toBe("| --- | --- | --- |");
    e.commands.deleteColumn();
    for (let i = 0; i < 3; i++) e.commands.goToNextCell(); // out of the header row, into the first body row
    e.commands.deleteRow();
    expect(md(e).split("\n").filter((l) => l.startsWith("|"))).toHaveLength(3);
    expect(md(e).split("\n")[1]).toBe("| --- | --- |");
    e.commands.deleteTable();
    expect(md(e)).toBe("text");
  });

  it("sets headings 1 to 6 and back to a paragraph", () => {
    const e = make("word");
    for (let level = 1; level <= 6; level++) {
      e.commands.setHeading({ level: level as 1 });
      expect(md(e)).toBe(`${"#".repeat(level)} word`);
    }
    e.commands.setParagraph();
    expect(md(e)).toBe("word");
  });

  it("adds a link to the selection and removes it", () => {
    const e = make("go here");
    e.commands.setTextSelection({ from: 4, to: 8 });
    e.commands.setLink({ href: "https://example.com" });
    expect(md(e)).toBe("go [here](https://example.com)");
    e.commands.extendMarkRange("link");
    e.commands.unsetLink();
    expect(md(e)).toBe("go here");
  });

  it("takes new Markdown from outside without echoing it as an edit", () => {
    const e = make("one");
    let updates = 0;
    e.on("update", () => updates++);
    e.commands.setContent("# two", { contentType: "markdown", emitUpdate: false });
    expect(updates).toBe(0);
    expect(md(e)).toBe("# two");
  });

  it("keeps Tab and Shift+Tab in a list inside the editor, even where the item cannot move", () => {
    const e = make("- one\n- two");
    // The first item has nothing to nest under: Tab does nothing, and the focus stays.
    e.commands.setTextSelection(3);
    expect(press(e, "Tab")).toBe(true);
    expect(md(e)).toBe("- one\n- two");
    // The second item nests under the first, and Shift+Tab brings it back.
    e.commands.setTextSelection(e.state.doc.content.size - 2);
    expect(press(e, "Tab")).toBe(true);
    expect(md(e)).toBe("- one\n  - two");
    expect(press(e, "Tab")).toBe(true);
    expect(press(e, "Tab", true)).toBe(true);
    expect(md(e)).toBe("- one\n- two");
  });

  it("leaves Tab to the browser outside lists, so the keyboard can still leave the editor", () => {
    const e = make("Just text");
    e.commands.setTextSelection(3);
    expect(press(e, "Tab")).toBe(false);
  });
});
