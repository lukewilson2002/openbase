import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, embedJson, embedOfBlock, isEmbedInfo, MAX_LIMIT, parseEmbed } from "./embeds";

const FIELD = "fldAbCdEfGhIjKl";
const VIEW = "viwAbCdEfGhIjKl";

describe("parseEmbed", () => {
  it("reads a linked records embed", () => {
    expect(parseEmbed(`{"embed":"linked","field":"${FIELD}"}`)).toEqual({ embed: "linked", field: FIELD });
  });

  it("reads a view embed, with a limit of 10 when it names none", () => {
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","limit":25}`)).toEqual({ embed: "view", view: VIEW, limit: 25 });
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}"}`)).toEqual({ embed: "view", view: VIEW, limit: DEFAULT_LIMIT });
  });

  it("ignores the whitespace around the object and the order of its keys", () => {
    expect(parseEmbed(`\n  {\n "field": "${FIELD}", "embed": "linked"\n}\n`)).toEqual({ embed: "linked", field: FIELD });
  });

  it.each([
    ["nothing", ""],
    ["whitespace", "  \n "],
    ["text", "not json"],
    ["a truncated object", `{"embed":"linked","field":"${FIELD}"`],
    ["an array", `[{"embed":"linked","field":"${FIELD}"}]`],
    ["a string", `"${FIELD}"`],
    ["null", "null"],
    ["two objects", `{"embed":"linked","field":"${FIELD}"}{"embed":"linked","field":"${FIELD}"}`],
    ["a trailing comma", `{"embed":"linked","field":"${FIELD}",}`],
    ["single quotes", `{'embed':'linked','field':'${FIELD}'}`],
  ])("does not read %s", (_what, text) => {
    expect(parseEmbed(text)).toBeNull();
  });

  it("needs a known kind", () => {
    expect(parseEmbed(`{"embed":"gallery","field":"${FIELD}"}`)).toBeNull();
    expect(parseEmbed(`{"field":"${FIELD}"}`)).toBeNull();
    expect(parseEmbed(`{"embed":1,"field":"${FIELD}"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"LINKED","field":"${FIELD}"}`)).toBeNull();
  });

  it("allows no key that is not the documented ones", () => {
    expect(parseEmbed(`{"embed":"linked","field":"${FIELD}","limit":5}`)).toBeNull();
    expect(parseEmbed(`{"embed":"linked","field":"${FIELD}","html":"<b>x</b>"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","field":"${FIELD}"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","limit":10,"src":"https://example.com"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","__proto__":{"polluted":true}}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","constructor":{}}`)).toBeNull();
  });

  it("allows no key to be written twice, whatever the first value says", () => {
    expect(parseEmbed(`{"embed":"view","view":"x","view":"${VIEW}"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view","view":"<img src=x onerror=alert(1)> \`\`\` hidden text","view":"${VIEW}"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"linked","field":"${FIELD}","field":"${FIELD}"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","limit":3,"limit":4}`)).toBeNull();
    // The same key spelled with an escape is still the same key.
    expect(parseEmbed(`{"embed":"view","vi\\u0065w":"x","view":"${VIEW}"}`)).toBeNull();
    // Colons, braces and quotes inside values are not keys.
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","limit":10}`)).toEqual({ embed: "view", view: VIEW, limit: 10 });
  });

  it("needs the id of its kind, in the shape of an id", () => {
    expect(parseEmbed(`{"embed":"linked"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view"}`)).toBeNull();
    // A view id in a linked embed and the other way round.
    expect(parseEmbed(`{"embed":"linked","field":"${VIEW}"}`)).toBeNull();
    expect(parseEmbed(`{"embed":"view","view":"${FIELD}"}`)).toBeNull();
    // Names are not ids.
    expect(parseEmbed(`{"embed":"linked","field":"Invoices"}`)).toBeNull();
    for (const bad of ["fld", "", "fld ", "fld/../x", "fld?x=1", "fld<script>", 'fld"onload="x', "fld\nx", "fld-x", "FLDabc", `fld${"a".repeat(41)}`, "javascript:alert(1)", "https://example.com/fldabc"]) {
      expect(parseEmbed(JSON.stringify({ embed: "linked", field: bad })), bad).toBeNull();
      expect(parseEmbed(JSON.stringify({ embed: "view", view: bad.replace(/^fld/, "viw") })), bad).toBeNull();
    }
    expect(parseEmbed(`{"embed":"linked","field":12}`)).toBeNull();
    expect(parseEmbed(`{"embed":"linked","field":["${FIELD}"]}`)).toBeNull();
    expect(parseEmbed(`{"embed":"linked","field":null}`)).toBeNull();
  });

  it("needs a limit that is a whole number from 1 to the most allowed", () => {
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","limit":1}`)).toMatchObject({ limit: 1 });
    expect(parseEmbed(`{"embed":"view","view":"${VIEW}","limit":${MAX_LIMIT}}`)).toMatchObject({ limit: MAX_LIMIT });
    for (const limit of ["0", "-1", `${MAX_LIMIT + 1}`, "1.5", '"10"', "null", "true", "[10]", "1e9", "NaN"]) {
      expect(parseEmbed(`{"embed":"view","view":"${VIEW}","limit":${limit}}`), limit).toBeNull();
    }
  });

  it("does not read a script, a tag or a long text as an embed", () => {
    expect(parseEmbed("<script>alert(1)</script>")).toBeNull();
    expect(parseEmbed(`{"embed":"linked","field":"${FIELD}"}<img src=x onerror=alert(1)>`)).toBeNull();
    expect(parseEmbed(`{"embed":"linked","field":"${FIELD}","pad":"${"x".repeat(600)}"}`)).toBeNull();
  });
});

describe("embedJson", () => {
  it("writes the documented key order and is read back as the same embed", () => {
    expect(embedJson({ embed: "linked", field: FIELD })).toBe(`{"embed":"linked","field":"${FIELD}"}`);
    expect(embedJson({ embed: "view", view: VIEW, limit: 10 })).toBe(`{"embed":"view","view":"${VIEW}","limit":10}`);
    expect(parseEmbed(embedJson({ embed: "view", view: VIEW, limit: 7 }))).toEqual({ embed: "view", view: VIEW, limit: 7 });
  });
});

describe("the info string", () => {
  it("marks a block whose first word is openbase, as the server's search does", () => {
    expect(isEmbedInfo("openbase")).toBe(true);
    expect(isEmbedInfo(" openbase ")).toBe(true);
    expect(isEmbedInfo("openbase extra words")).toBe(true);
    expect(isEmbedInfo("json")).toBe(false);
    expect(isEmbedInfo("OpenBase")).toBe(false);
    expect(isEmbedInfo("openbases")).toBe(false);
    expect(isEmbedInfo(null)).toBe(false);
    expect(isEmbedInfo(undefined)).toBe(false);
    expect(isEmbedInfo("")).toBe(false);
  });

  it("holds a readable embed only when it is exactly openbase", () => {
    const body = `{"embed":"linked","field":"${FIELD}"}`;
    expect(embedOfBlock("openbase", body)).toEqual({ embed: "linked", field: FIELD });
    expect(embedOfBlock("openbase extra", body)).toBeNull();
    expect(embedOfBlock("json", body)).toBeNull();
    expect(embedOfBlock(null, body)).toBeNull();
  });
});
