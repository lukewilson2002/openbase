import { describe, expect, it, vi } from "vitest";
import { guessType } from "./index";
import examples from "./examples.json";

type Compared = Record<string, unknown>;

interface Example {
  value: string;
  guess: { rule: number; type: string; options?: Compared };
  csv: { type: string; options?: Compared };
  agree: boolean;
  why?: string;
}

const cases = examples.cases as Example[];

/** The options named in `want` must be present in `have` with the same values. */
function subset(have: object, want: Compared | undefined): Compared {
  return Object.fromEntries(Object.keys(want ?? {}).map((k) => [k, (have as Compared)[k]]));
}

describe("the shared example table", () => {
  it.each(cases.map((c) => [JSON.stringify(c.value), c] as const))("FLD-1 on %s", (_label, c) => {
    const g = guessType(c.value);
    expect(g.type).toBe(c.guess.type);
    expect(g.rule).toBe(c.guess.rule);
    expect(subset(g.options, c.guess.options)).toEqual(c.guess.options ?? {});
  });

  it.each(cases.map((c) => [JSON.stringify(c.value), c] as const))("%s: the rows that agree with the CSV importer really do", (_label, c) => {
    if (c.agree) {
      expect(c.csv.type).toBe(c.guess.type);
      // Every option the importer's side names is one the guess names too, and they are equal.
      for (const [k, v] of Object.entries(c.csv.options ?? {})) expect(c.guess.options?.[k]).toEqual(v);
      expect(c.why).toBeUndefined();
    } else {
      expect(c.why, "a row that differs says why").toBeTruthy();
      const sameOptions = Object.entries(c.csv.options ?? {}).every(([k, v]) => JSON.stringify(c.guess.options?.[k]) === JSON.stringify(v));
      expect(c.csv.type === c.guess.type && sameOptions, "a row marked as differing differs").toBe(false);
    }
  });

  it("has an example for every rule of the table", () => {
    const seen = new Set(cases.map((c) => c.guess.rule));
    for (let rule = 1; rule <= 14; rule++) expect(seen.has(rule), `rule ${rule}`).toBe(true);
  });
});

/** [value, type, rule] */
type Row = readonly [string, string, number];

function table(rows: readonly Row[]) {
  it.each(rows)("%j is %s (rule %i)", (value, type, rule) => {
    const g = guessType(value);
    expect({ type: g.type, rule: g.rule }).toEqual({ type, rule });
  });
}

describe("rule 1: nothing", () => {
  table([
    ["", "text", 1],
    [" ", "text", 1],
    ["   ", "text", 1],
    ["\t", "text", 1],
    ["\n", "text", 1],
    [" \n \n ", "text", 1],
  ]);
  it("is single-line text", () => {
    expect(guessType("").options).toEqual({ multiline: false });
  });
});

describe("rule 2: checkbox words", () => {
  table([
    ["yes", "checkbox", 2],
    ["no", "checkbox", 2],
    ["true", "checkbox", 2],
    ["false", "checkbox", 2],
    ["Yes", "checkbox", 2],
    ["NO", "checkbox", 2],
    ["True", "checkbox", 2],
    ["FALSE", "checkbox", 2],
    ["✓", "checkbox", 2],
    ["✗", "checkbox", 2],
    ["  yes  ", "checkbox", 2],
  ]);

  describe("near misses", () => {
    table([
      ["yes please", "text", 14],
      ["no way", "text", 14],
      ["yes yes", "text", 14],
      ["y", "text", 14],
      ["n", "text", 14],
      ["yep", "text", 14],
      ["nope", "text", 14],
      ["on", "text", 14],
      ["off", "text", 14],
      ["checked", "text", 14],
      ["true.", "text", 14],
      ["truee", "text", 14],
      ["✓✓", "text", 14],
      ["✔", "text", 14],
      ["1", "number", 11],
      ["0", "number", 11],
      ["yes\nno", "text", 13],
    ]);
  });

  it("comes with the usual icon and color", () => {
    expect(guessType("yes").options).toEqual({ icon: "check", color: "green" });
  });
});

describe("rule 3: email", () => {
  table([
    ["dana@harperco.example", "email", 3],
    ["dana.smith+work@harperco.example", "email", 3],
    ["d@h.co", "email", 3],
    ["dana@mail.harperco.example", "email", 3],
    ["  dana@harperco.example ", "email", 3],
  ]);

  describe("near misses", () => {
    table([
      ["dana@harperco", "text", 14],
      ["@harperco.example", "text", 14],
      ["dana@", "text", 14],
      ["dana @harperco.example", "text", 14],
      ["dana@@harperco.example", "text", 14],
      ["dana@harperco.example and sam@harperco.example", "text", 14],
      ["Dana <dana@harperco.example>", "text", 14],
      ["mailto:dana@harperco.example", "text", 14],
      ["dana at harperco.example", "text", 14],
      ["dana@harperco.example.", "text", 14], // a full stop ends the sentence, not the domain (the importer rejects it too)
      ["https://dana@harperco.example", "url", 4],
    ]);
  });
});

describe("rule 4: web address", () => {
  table([
    ["https://harperco.example", "url", 4],
    ["http://harperco.example/book", "url", 4],
    ["HTTPS://HARPERCO.EXAMPLE", "url", 4],
    ["ftp://files.harperco.example/a.zip", "url", 4],
    ["http://localhost:3000", "url", 4],
    ["https://harperco.example/book?a=1&b=2#top", "url", 4],
    ["www.harperco.example", "url", 4],
    ["www.harperco.example/book", "url", 4],
    ["WWW.harperco.example", "url", 4],
    ["harperco.example/book", "url", 4],
    ["harperco.example/", "url", 4],
    ["harperco.example/book?x=1", "url", 4],
    ["sub.harperco.example/a/b", "url", 4],
    ["harperco.example:8080/status", "url", 4],
  ]);

  describe("near misses", () => {
    table([
      ["harperco.example", "text", 14],
      ["harperco", "text", 14],
      ["harperco.", "text", 14],
      ["notes.txt", "text", 14],
      ["v1.2/notes", "text", 14],
      ["e.g. harperco.example/book", "text", 14],
      ["see harperco.example/book", "text", 14],
      ["https://", "text", 14],
      ["https:// harperco.example", "text", 14],
      ["harperco.example/book and more", "text", 14],
      ["www.", "text", 14],
      ["www.harperco", "text", 14],
      ["/book", "text", 14],
      ["a/b", "text", 14],
    ]);
  });
});

describe("rule 5: phone", () => {
  table([
    ["+1 870 555 0100", "phone", 5],
    ["+18705550100", "phone", 5],
    ["+44 20 7946 0958", "phone", 5],
    ["(870) 555-0100", "phone", 5],
    ["870-555-0100", "phone", 5],
    ["870 555 0100", "phone", 5],
    ["1-800-555-0100", "phone", 5],
    ["555-0100", "phone", 5],
    ["+1 (870) 555-0100", "phone", 5],
    ["+123456789012345", "phone", 5], // 15 digits
    ["+1234567", "phone", 5], // 7 digits
  ]);

  describe("near misses", () => {
    table([
      ["1234567", "number", 11], // digits alone are a number or an identifier
      ["8705550100", "number", 11],
      ["123456", "number", 11],
      ["555-010", "text", 14], // 6 digits
      ["+1 234", "text", 14],
      ["+1234567890123456", "text", 14], // 16 digits
      ["1 234 567 890 123 456", "text", 14],
      ["-1234567", "number", 11],
      ["555-0100 ext 2", "text", 14],
      ["call 870 555 0100", "text", 14],
      ["870.555.0100", "text", 14],
      ["(870 555-0100", "text", 14],
      ["870) 555-0100", "text", 14],
      ["+", "text", 14],
      ["++1 870 555 0100", "text", 14],
      ["2026-11-14", "date", 10], // eight digits and dashes, but a date
      ["2026-13-45", "text", 14],
      ["12-25-2026", "text", 14], // dashed dates, years, ISBNs and thousands are not phone numbers (GT-1)
      ["25-12-2026", "text", 14],
      ["2024-1-15", "text", 14],
      ["2020-2024", "text", 14],
      ["1000-2000", "text", 14],
      ["978-0-306-40615-7", "text", 14],
      ["1 000 000", "text", 14],
      ["123 456 789", "text", 14],
    ]);
  });
});

describe("rule 6: currency", () => {
  const cur = (v: string) => guessType(v).options;
  table([
    ["$600", "currency", 6],
    ["€600", "currency", 6],
    ["£600", "currency", 6],
    ["¥600", "currency", 6],
    ["$1,200", "currency", 6],
    ["$1,200,000.50", "currency", 6],
    ["$0", "currency", 6],
    ["$0.99", "currency", 6],
    ["$ 600", "currency", 6],
    ["-$5", "currency", 6],
    ["$-5", "currency", 6],
    ["600$", "currency", 6],
    ["600 €", "currency", 6],
  ]);

  it("keeps the symbol and gives at least two decimals", () => {
    expect(cur("$600")).toEqual({ precision: 2, symbol: "$", allow_negative: true });
    expect(cur("£5.5")).toEqual({ precision: 2, symbol: "£", allow_negative: true });
    expect(cur("¥1.1234")).toEqual({ precision: 4, symbol: "¥", allow_negative: true });
    expect(cur("€1.12345678")).toEqual({ precision: 8, symbol: "€", allow_negative: true });
  });

  describe("near misses", () => {
    table([
      ["$", "text", 14],
      ["$abc", "text", 14],
      ["$1,2", "text", 14],
      ["$1,2345", "text", 14],
      ["$600 USD", "text", 14],
      ["US$600", "text", 14],
      ["USD 600", "text", 14],
      ["$600$", "text", 14],
      ["$$600", "text", 14],
      ["-$-5", "text", 14],
      ["$1.123456789", "text", 14], // more than 8 decimals
      ["$1234567890123456", "text", 14], // 16 digits
      ["₹600", "text", 14],
      ["$600%", "text", 14],
      ["$01", "text", 14],
      ["$.5", "text", 14],
      ["600", "number", 11],
    ]);
  });
});

describe("rule 7: percent", () => {
  table([
    ["15%", "percent", 7],
    ["12.5%", "percent", 7],
    ["12.5 %", "percent", 7],
    ["-3%", "percent", 7],
    ["0%", "percent", 7],
    ["100%", "percent", 7],
    ["150%", "percent", 7],
    ["1,000%", "percent", 7],
  ]);

  it("keeps the decimals it saw", () => {
    expect(guessType("15%").options).toEqual({ precision: 0, allow_negative: true });
    expect(guessType("12.5%").options).toEqual({ precision: 1, allow_negative: true });
    expect(guessType("12.345%").options).toEqual({ precision: 3, allow_negative: true });
  });

  describe("near misses", () => {
    table([
      ["%", "text", 14],
      ["%15", "text", 14],
      ["15 %%", "text", 14],
      ["15 percent", "text", 14],
      ["about 15%", "text", 14],
      ["15% off", "text", 14],
      ["1.5.5%", "text", 14],
      ["12.123456789%", "text", 14],
      ["+15%", "text", 14],
      ["15", "number", 11],
    ]);
  });
});

describe("rule 8: duration", () => {
  const fmt = (v: string) => (guessType(v).options as { format: string }).format;
  table([
    ["1:30", "duration", 8],
    ["0:45", "duration", 8],
    ["12:05", "duration", 8],
    ["100:00", "duration", 8],
    ["14:30", "duration", 8],
    ["1:30:15", "duration", 8],
    ["2h 30m", "duration", 8],
    ["2h30m", "duration", 8],
    ["2H 30M", "duration", 8],
    ["2h", "duration", 8],
    ["2 h", "duration", 8],
    ["1.5h", "duration", 8],
    ["1.5 hours", "duration", 8],
    ["45 min", "duration", 8],
    ["45min", "duration", 8],
    ["45 mins", "duration", 8],
    ["45 minutes", "duration", 8],
    ["1 hour", "duration", 8],
    ["2 hrs", "duration", 8],
    ["1 hour 15 minutes", "duration", 8],
    ["1h 30m 15s", "duration", 8],
    ["90 sec", "duration", 8],
    ["90 seconds", "duration", 8],
    ["1 min 30 sec", "duration", 8],
  ]);

  it("chooses the format by the smallest unit written", () => {
    expect(fmt("1:30")).toBe("h_mm");
    expect(fmt("2h 30m")).toBe("h_mm");
    expect(fmt("45 min")).toBe("h_mm");
    expect(fmt("1:30:15")).toBe("h_mm_ss");
    expect(fmt("1h 30m 15s")).toBe("h_mm_ss");
    expect(fmt("90 sec")).toBe("h_mm_ss");
  });

  describe("near misses", () => {
    table([
      ["1:60", "text", 14],
      ["1:5", "text", 14],
      [":30", "text", 14],
      ["1:30:60", "text", 14],
      ["1:30:15:10", "text", 14],
      ["10:30am", "text", 14], // a time of day
      ["5m", "text", 14], // meters, millions or minutes
      ["30m", "text", 14],
      ["5s", "text", 14],
      ["2h 30", "text", 14],
      ["30m 2h", "text", 14], // units out of order
      ["2h 2h", "text", 14],
      ["2h30", "text", 14],
      ["h", "text", 14],
      ["min", "text", 14],
      ["about 2h", "text", 14],
      ["2 hours ago", "text", 14],
      ["2hx", "text", 14],
      ["-2h", "text", 14],
    ]);
  });
});

describe("rules 9 and 10: dates", () => {
  const opts = (v: string) => guessType(v).options;
  table([
    ["Nov 14 9am", "date", 9],
    ["Nov 14 at 9am", "date", 9],
    ["Nov 14 14:30", "date", 9],
    ["tomorrow 9am", "date", 9],
    ["Friday at 2pm", "date", 9],
    ["next Friday at noon", "date", 9],
    ["11/14 3pm", "date", 9],
    ["2026-11-14T10:00", "date", 9],
    ["2026-11-14T10:00:00Z", "date", 9],
    ["2026-11-14 10:00", "date", 9],
    ["Nov 14", "date", 10],
    ["nov 14", "date", 10],
    ["November 14, 2027", "date", 10],
    ["14 Nov", "date", 10],
    ["11/14", "date", 10],
    ["14/11", "date", 10],
    ["11/14/2026", "date", 10],
    ["2026-11-14", "date", 10],
    ["today", "date", 10],
    ["tomorrow", "date", 10],
    ["tonight", "date", 10],
    ["Friday", "date", 10],
    ["next Friday", "date", 10],
    ["this Friday", "date", 10],
    ["by Friday", "date", 10],
    ["1/2", "date", 10],
  ]);

  it("shows the date the way it was written", () => {
    expect(opts("Nov 14")).toEqual({ include_time: false, date_format: "friendly", time_format: "h12" });
    expect(opts("11/14")).toEqual({ include_time: false, date_format: "us", time_format: "h12" });
    expect(opts("14/11")).toEqual({ include_time: false, date_format: "european", time_format: "h12" });
    expect(opts("2026-11-14")).toEqual({ include_time: false, date_format: "iso", time_format: "h12" });
    expect(opts("Nov 14 9am")).toEqual({ include_time: true, date_format: "friendly", time_format: "h12" });
    expect(opts("Nov 14 14:30")).toEqual({ include_time: true, date_format: "friendly", time_format: "h24" });
    expect(opts("2026-11-14T10:00")).toEqual({ include_time: true, date_format: "iso", time_format: "h24" });
  });

  describe("near misses", () => {
    table([
      ["Call Dana tomorrow", "text", 14], // a sentence, not a date
      ["Friday meeting", "text", 14],
      ["Fridays", "text", 14],
      ["9am", "text", 14], // a time alone is not a date
      ["noon", "text", 14],
      ["at 9am", "text", 14],
      ["Nov", "text", 14],
      ["May", "text", 14],
      ["Nov 32", "text", 14],
      ["Feb 30", "text", 14],
      ["13/13", "text", 14],
      ["2/30", "text", 14],
      ["Nov 14 Nov 15", "text", 14],
      ["Nov 14-16", "text", 14],
      ["tomorrow tomorrow", "text", 14],
      ["2026-11", "text", 14],
      ["11/14/", "text", 14],
      ["2024", "number", 11], // a year alone is a number
      ["1/2 cup", "text", 14],
    ]);
  });

  it("does not depend on the day it is asked", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-02-28T23:59:59Z"));
      const late = guessType("Nov 14");
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      expect(guessType("Nov 14")).toEqual(late);
      expect(guessType("Feb 29").type).toBe("date");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rule 11: number", () => {
  const prec = (v: string) => (guessType(v).options as { precision: number }).precision;
  table([
    ["42", "number", 11],
    ["0", "number", 11],
    ["-5", "number", 11],
    ["3.5", "number", 11],
    ["-0.5", "number", 11],
    ["0.125", "number", 11],
    ["1000", "number", 11],
    ["1,000", "number", 11],
    ["1,250.5", "number", 11],
    ["1,000,000", "number", 11],
    ["999,999,999", "number", 11],
    ["2024", "number", 11],
    ["123456789012345", "number", 11], // 15 digits
    ["1.12345678", "number", 11], // 8 decimals
  ]);

  it("keeps the decimals it saw", () => {
    expect(prec("42")).toBe(0);
    expect(prec("3.5")).toBe(1);
    expect(prec("1,250.5")).toBe(1);
    expect(prec("0.125")).toBe(3);
    expect(prec("1.12345678")).toBe(8);
    expect(guessType("42").options).toEqual({ precision: 0, allow_negative: true });
  });

  describe("near misses", () => {
    table([
      ["007", "text", 14], // identifiers keep their zeros
      ["02134", "text", 14],
      ["00", "text", 14],
      ["1,00", "text", 14],
      ["12,34", "text", 14],
      ["1,0000", "text", 14],
      [",100", "text", 14],
      ["1,000,", "text", 14],
      ["1.", "text", 14],
      [".5", "text", 14],
      ["+5", "text", 14],
      ["1e5", "text", 14],
      ["0x10", "text", 14],
      ["1 000", "text", 14],
      ["1.2.3", "text", 14],
      ["--5", "text", 14],
      ["5-", "text", 14],
      ["1234567890123456", "text", 14], // 16 digits
      ["12345678901234567890", "text", 14],
      ["1.123456789", "text", 14], // 9 decimals
      ["NaN", "text", 14],
      ["Infinity", "text", 14],
    ]);
  });
});

describe("rule 12: stars", () => {
  const max = (v: string) => (guessType(v).options as { max: number }).max;
  table([
    ["★", "rating", 12],
    ["★★★", "rating", 12],
    ["★★★★★", "rating", 12],
    ["★★★☆☆", "rating", 12],
    ["⭐⭐⭐", "rating", 12],
    ["★★★★★★★", "rating", 12],
    ["★★★★★★★★★★", "rating", 12],
  ]);

  it("is out of 5 unless more stars were written", () => {
    expect(max("★")).toBe(5);
    expect(max("★★★")).toBe(5);
    expect(max("★★★★★")).toBe(5);
    expect(max("★★★★★★★")).toBe(7);
    expect(max("★★★☆☆")).toBe(5);
    expect(max("★★☆")).toBe(3);
    expect(max("★★★★★★★★★★")).toBe(10);
    expect(guessType("★★★").options).toEqual({ max: 5, icon: "star", color: "yellow" });
  });

  describe("near misses", () => {
    table([
      ["☆☆☆", "text", 14], // no star filled
      ["★★★★★★★★★★★", "text", 14], // more than ten
      ["★ ★ ★", "text", 14],
      ["★★★ great", "text", 14],
      ["***", "text", 14],
      ["3 stars", "text", 14],
      ["★★★\n", "rating", 12], // a trailing newline is trimmed
    ]);
  });
});

describe("rule 13: several lines", () => {
  table([
    ["Line one\nLine two", "text", 13],
    ["Line one\r\nLine two", "text", 13],
    ["a\n\nb", "text", 13],
    ["yes\nno", "text", 13],
    ["dana@harperco.example\nsam@harperco.example", "text", 13],
    ["$600\n$700", "text", 13],
    ["1\n2", "text", 13],
    ["Nov 14\nNov 15", "text", 13],
    ["https://harperco.example\nhttps://example.org", "text", 13],
  ]);

  it("keeps the line breaks", () => {
    expect(guessType("a\nb").options).toEqual({ multiline: true });
  });

  it("ignores a break at either end", () => {
    expect(guessType("Harper\n").rule).toBe(14);
    expect(guessType("\nHarper").rule).toBe(14);
    expect(guessType("dana@harperco.example\n").rule).toBe(3);
  });
});

describe("rule 14: anything else", () => {
  table([
    ["Harper", "text", 14],
    ["Harper & Sons", "text", 14],
    ["hello world", "text", 14],
    ["Q4 plan", "text", 14],
    ["#123", "text", 14],
    ["N/A", "text", 14],
    ["-", "text", 14],
    ["?", "text", 14],
    ["日本語", "text", 14],
    ["x".repeat(300), "text", 14],
  ]);
  it("is single-line text", () => {
    expect(guessType("Harper").options).toEqual({ multiline: false });
  });
});

describe("the first rule that matches wins", () => {
  it("pins the edges the spec names", () => {
    expect(guessType("2024").type).toBe("number");
    expect(guessType("11/14").type).toBe("date");
    expect(guessType("1,000").type).toBe("number");
    expect(guessType("+1 870 555 0100").type).toBe("phone");
  });

  it.each([
    ["an email beats a web address", "https://dana@harperco.example", "url"], // no email: a slash cannot be in an address
    ["a web address beats a date", "11/14/2026", "date"],
    ["a phone beats a number", "555-0100", "phone"],
    ["a currency beats a number", "$600", "currency"],
    ["a percent beats a number", "15%", "percent"],
    ["a duration beats a date", "14:30", "duration"],
    ["a date with a time beats a date", "Nov 14 9am", "date"],
    ["a date beats a number", "11/14", "date"],
    ["a number beats stars", "5", "number"],
  ])("%s", (_name, value, type) => {
    expect(guessType(value).type).toBe(type);
  });

  it("numbers the rules as the table does", () => {
    const by: Record<number, string> = { 2: "yes", 3: "a@b.co", 4: "www.x.co", 5: "+1 870 555 0100", 6: "$1", 7: "1%", 8: "1:30", 9: "Nov 14 9am", 10: "Nov 14", 11: "12", 12: "★", 13: "a\nb", 14: "a" };
    for (const [rule, value] of Object.entries(by)) expect(guessType(value).rule, value).toBe(Number(rule));
  });
});

describe("the module is pure", () => {
  it("gives the same answer every time and ignores surrounding space", () => {
    for (const value of ["Nov 14", "$600", "1,250.5", "Harper", "", "a\nb"]) {
      expect(guessType(value)).toEqual(guessType(value));
      expect(guessType(`  ${value}  `).type).toBe(guessType(value).type);
    }
  });

  it("returns options a new property can be created with", () => {
    for (const c of cases) {
      const g = guessType(c.value);
      expect(typeof g.options).toBe("object");
      expect(g.options).not.toBeNull();
    }
  });
});
