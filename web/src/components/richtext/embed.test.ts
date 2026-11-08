import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richTextExtensions } from "./extensions";
import { normalizeMarkdown } from "./extensions";

const FIELD = "fldAbCdEfGhIjKl";
const VIEW = "viwAbCdEfGhIjKl";
const linked = `{"embed":"linked","field":"${FIELD}"}`;

let editor: Editor | null = null;
function open(md: string): Editor {
  editor = new Editor({ element: document.createElement("div"), extensions: richTextExtensions(), content: md, contentType: "markdown" });
  return editor;
}
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const types = (ed: Editor) => (ed.getJSON().content ?? []).map((n) => n.type);

describe("the embed block in the editor", () => {
  it("reads a valid openbase block as an embed holding the text it was written as", () => {
    const ed = open(`\`\`\`openbase\n${linked}\n\`\`\``);
    expect(ed.getJSON().content).toEqual([{ type: "embed", attrs: { source: linked } }]);
  });

  it("reads both kinds, with or without a limit", () => {
    const ed = open(`\`\`\`openbase\n{"embed":"view","view":"${VIEW}"}\n\`\`\`\n\n\`\`\`openbase\n{"embed":"view","view":"${VIEW}","limit":5}\n\`\`\``);
    expect(types(ed)).toEqual(["embed", "embed"]);
  });

  it("writes back exactly what it read, so an agent's own spacing survives", () => {
    const pretty = `{\n  "embed": "view",\n  "view": "${VIEW}",\n  "limit": 3\n}`;
    const md = `before\n\n\`\`\`openbase\n${pretty}\n\`\`\`\n\nafter`;
    expect(open(md).getMarkdown()).toBe(md);
  });

  it("leaves a block that does not read as the code it is, with its text unchanged", () => {
    for (const body of [
      "not json {",
      `{"embed":"linked","field":"${FIELD}","extra":true}`,
      `{"embed":"linked","field":"Invoices"}`,
      `{"embed":"view","view":"${VIEW}","limit":0}`,
      `{"embed":"gallery","view":"${VIEW}"}`,
      "<script>alert(1)</script>",
      `{"embed":"linked","field":"${FIELD}"}\n{"embed":"linked","field":"${FIELD}"}`,
    ]) {
      const md = `\`\`\`openbase\n${body}\n\`\`\``;
      const ed = open(md);
      expect(types(ed), body).toEqual(["codeBlock"]);
      expect(ed.getMarkdown(), body).toBe(md);
      editor?.destroy();
    }
  });

  it("does not read a block with another info string, an indented one, or one in a quote as an embed", () => {
    expect(types(open(`\`\`\`json\n${linked}\n\`\`\``))).toEqual(["codeBlock"]);
    editor?.destroy();
    expect(types(open(`\`\`\`openbase extra\n${linked}\n\`\`\``))).toEqual(["codeBlock"]);
    editor?.destroy();
    expect(types(open(`    ${linked}`))).toEqual(["codeBlock"]);
    editor?.destroy();
    expect(types(open(`\`\`\`\n${linked}\n\`\`\``))).toEqual(["codeBlock"]);
  });

  it("is the same through a save and a reload, and settles", () => {
    const md = `\`\`\`openbase\n${linked}\n\`\`\`\n\n\`\`\`openbase\nbroken\n\`\`\``;
    const once = normalizeMarkdown(md);
    expect(once).toBe(md);
    expect(normalizeMarkdown(once)).toBe(once);
  });

  it("labels a block that cannot be shown, and only that one, without changing its text", () => {
    const ed = open(`\`\`\`openbase\nbroken\n\`\`\`\n\n\`\`\`ts\nconst a = 1;\n\`\`\``);
    const marked = ed.view.dom.querySelectorAll("pre.ob-embed-code");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveAttribute("data-note", "This embed can't be shown");
    expect(marked[0]!.textContent).toBe("broken");
  });

  it("turns a code block typed by hand into the embed when the editor loses the focus, not before", () => {
    const ed = open("");
    ed.commands.setCodeBlock({ language: "openbase" });
    ed.commands.insertContent(linked);
    expect(types(ed)).toEqual(["codeBlock"]);
    ed.view.dom.dispatchEvent(new FocusEvent("blur"));
    ed.emit("blur", { editor: ed, event: new FocusEvent("blur"), transaction: ed.state.tr } as never);
    expect(types(ed)).toEqual(["embed"]);
    expect(ed.getMarkdown()).toBe(`\`\`\`openbase\n${linked}\n\`\`\``);
  });

  it("reads a pasted embed again, and drops one whose text does not read", () => {
    const ed = open("");
    const html = (source: string) => `<div data-ob-embed-source='${source}' class="ob-embed">Embedded view</div>`;
    ed.commands.insertContent(html(linked));
    expect(types(ed)).toEqual(["embed"]);
    ed.commands.clearContent();
    ed.commands.insertContent(html(`{"embed":"linked","field":"nope"}`));
    expect(types(ed)).not.toContain("embed");
  });
});
