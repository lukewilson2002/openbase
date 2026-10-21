import { describe, expect, it } from "vitest";
import { MENTION_AT_START, matchPeople, mentionMarkup, mentionedUserIds, openMention, parseMentions } from "./mentions";

describe("mentions", () => {
  it("parses @[Name](usrXXX) markup", () => {
    expect(parseMentions("Hi @[Ada Lovelace](usr1), see this")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "mention", userId: "usr1", name: "Ada Lovelace" },
      { kind: "text", text: ", see this" },
    ]);
    expect(parseMentions("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(parseMentions("@[Bad](notauser)")).toEqual([{ kind: "text", text: "@[Bad](notauser)" }]);
    expect(MENTION_AT_START.exec("@[Ada](usr1) rest")?.slice(1)).toEqual(["Ada", "usr1"]);
    expect(MENTION_AT_START.exec("x @[Ada](usr1)")).toBeNull();
  });
  it("lists mentioned users once", () => {
    expect(mentionedUserIds("@[A](usr1) and @[B](usr2) and @[A](usr1)")).toEqual(["usr1", "usr2"]);
  });
  it("builds markup that stays one link", () => {
    expect(mentionMarkup({ userId: "usr1", name: "Ada [x]" })).toBe("@[Ada x](usr1)");
    expect(mentionMarkup({ userId: "usr1", name: "Back\\slash\nline" })).toBe("@[Backslashline](usr1)");
    expect(mentionMarkup({ userId: "usr1", name: "[]" })).toBe("@[someone](usr1)");
  });
  it("detects an @ being typed", () => {
    expect(openMention("hello @ad", 9)).toEqual({ start: 6, query: "ad" });
    expect(openMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(openMention("mail me@example", 15)).toBeNull(); // not at a word start
    expect(openMention("hello @ad done", 14)).toBeNull(); // caret after a space
  });
  it("matches people by name or the start of their email", () => {
    const people = [
      { id: "usr1", name: "Ada Lovelace", email: "ada@example.com" },
      { id: "usr2", name: "Grace Hopper", email: "grace@example.com" },
    ];
    expect(matchPeople(people, "").map((p) => p.id)).toEqual(["usr1", "usr2"]);
    expect(matchPeople(people, "LOVE").map((p) => p.id)).toEqual(["usr1"]);
    expect(matchPeople(people, "gra").map((p) => p.id)).toEqual(["usr2"]);
    expect(matchPeople(people, "example")).toEqual([]);
    expect(matchPeople(people, "", 1)).toHaveLength(1);
  });
});
