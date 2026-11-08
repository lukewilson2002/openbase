import { describe, expect, it } from "vitest";
import { BLOCKS, embedBlock, matchBlocks } from "./blocks";
import { openSlash } from "./slash";

describe("openSlash", () => {
  it("opens at a slash that starts the block or follows a space, and reads what is typed after it", () => {
    expect(openSlash("/")).toEqual({ start: 0, query: "" });
    expect(openSlash("/head")).toEqual({ start: 0, query: "head" });
    expect(openSlash("some text /li")).toEqual({ start: 10, query: "li" });
    expect(openSlash("/heading 1")).toEqual({ start: 0, query: "heading 1" });
    // The last slash is the one being typed.
    expect(openSlash("1/2 then /ta")).toEqual({ start: 9, query: "ta" });
  });

  it("is not a command inside words, addresses and paths", () => {
    expect(openSlash("and/or")).toBeNull();
    expect(openSlash("see https://example.com")).toBeNull();
    expect(openSlash("1/2")).toBeNull();
    expect(openSlash("a//b")).toBeNull();
    expect(openSlash("no slash")).toBeNull();
    expect(openSlash("")).toBeNull();
  });

  it("gives up on a long query and on one with an inline leaf in it", () => {
    expect(openSlash(`/${"x".repeat(24)}`)).not.toBeNull();
    expect(openSlash(`/${"x".repeat(25)}`)).toBeNull();
    expect(openSlash("/he￼llo")).toBeNull();
  });
});

describe("matchBlocks", () => {
  const labels = (query: string) => matchBlocks(BLOCKS, query).map((b) => b.label);

  it("lists the blocks in the order the spec gives with nothing typed", () => {
    expect(labels("")).toEqual(["Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "Checklist", "Quote", "Callout", "Code block", "Table", "Divider", "Image or file", "Linked records", "View", "Property"]);
  });

  it("narrows by the start of any word of the name or its other names", () => {
    expect(labels("head")).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    expect(labels("heading 2")).toEqual(["Heading 2"]);
    expect(labels("list")).toEqual(["Bulleted list", "Numbered list"]);
    expect(labels("todo")).toEqual(["Checklist"]);
    expect(labels("hr")).toEqual(["Divider"]);
    expect(labels("photo")).toEqual(["Image or file"]);
    expect(labels("zzz")).toEqual([]);
  });

  it("puts a block whose name matches before one found only by its other names", () => {
    // "table" is in Table's name, and in Linked records' other names.
    expect(labels("table")).toEqual(["Table", "Linked records"]);
  });

  it("matches case-insensitively and ignores punctuation", () => {
    expect(labels("/BULL")).toEqual(["Bulleted list"]);
    expect(labels("code-block")).toEqual(["Code block"]);
  });
});

describe("embedBlock", () => {
  it("is a code block with the openbase info string and one JSON object, then a paragraph to go on in", () => {
    expect(embedBlock({ embed: "linked", field: "fld1" })).toEqual([
      { type: "codeBlock", attrs: { language: "openbase" }, content: [{ type: "text", text: '{"embed":"linked","field":"fld1"}' }] },
      { type: "paragraph" },
    ]);
    expect(embedBlock({ embed: "view", view: "viw1", limit: 10 })[0]!.content![0]!.text).toBe('{"embed":"view","view":"viw1","limit":10}');
  });
});
