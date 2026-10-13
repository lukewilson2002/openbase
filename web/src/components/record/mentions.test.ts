import { describe, expect, it } from "vitest";
import { insertMention, mentionMarkup, mentionedUserIds, openMention, parseComment, plainComment } from "./mentions";

describe("mentions", () => {
  it("parses @[Name](usrXXX) markup", () => {
    expect(parseComment("Hi @[Ada Lovelace](usr1), see this")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "mention", userId: "usr1", name: "Ada Lovelace" },
      { kind: "text", text: ", see this" },
    ]);
    expect(parseComment("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(parseComment("@[Bad](notauser)")).toEqual([{ kind: "text", text: "@[Bad](notauser)" }]);
  });
  it("lists mentioned users once", () => {
    expect(mentionedUserIds("@[A](usr1) and @[B](usr2) and @[A](usr1)")).toEqual(["usr1", "usr2"]);
  });
  it("builds safe markup", () => {
    expect(mentionMarkup({ userId: "usr1", name: "Ada [x]" })).toBe("@[Ada x](usr1)");
    expect(plainComment("Hi @[Ada](usr1)!")).toBe("Hi @Ada!");
  });
  it("detects an @ being typed", () => {
    expect(openMention("hello @ad", 9)).toEqual({ start: 6, query: "ad" });
    expect(openMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(openMention("mail me@example", 15)).toBeNull(); // not at a word start
    expect(openMention("hello @ad done", 14)).toBeNull(); // caret after a space
  });
  it("inserts a mention in place of the typed query", () => {
    const text = "hi @ad there";
    const open = openMention(text, 6)!;
    const out = insertMention(text, 6, open, { userId: "usr1", name: "Ada Lovelace" });
    expect(out.text).toBe("hi @[Ada Lovelace](usr1)  there");
    expect(out.text.slice(0, out.caret)).toBe("hi @[Ada Lovelace](usr1) ");
  });
});
