import { describe, expect, it } from "vitest";
import { MAX_CSV_BYTES } from "@/api/sharing";
import { fileProblem, readCsvHead } from "./read";

const file = (content: string | Uint8Array, name = "data.csv") => new File([content as BlobPart], name, { type: "text/csv" });

describe("looking at a CSV file before importing it", () => {
  it("reads the rows and the width", async () => {
    const res = await readCsvHead(file("Name,Qty\nAnn,1\nBob,2,extra\n"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.head.preview.rows).toEqual([["Name", "Qty"], ["Ann", "1"], ["Bob", "2", "extra"]]);
    expect(res.head.width).toBe(3);
  });

  it("refuses empty, UTF-16 and row-less files, with a reason", async () => {
    expect(await readCsvHead(file(""))).toEqual({ ok: false, error: "This file is empty." });
    expect(await readCsvHead(file(Uint8Array.from([0xff, 0xfe, 0x61, 0x00])))).toMatchObject({ ok: false, error: expect.stringMatching(/UTF-16/) as string });
    expect(await readCsvHead(file("\n\n  \n"))).toEqual({ ok: false, error: "This file has no rows." });
  });

  it("states the 20 MB limit from the size alone", () => {
    expect(fileProblem({ name: "big.csv", size: MAX_CSV_BYTES + 1 })).toMatch(/limit is 20 MB/);
    expect(fileProblem({ name: "ok.csv", size: MAX_CSV_BYTES })).toBeNull();
  });

  it("refuses more columns than the server takes", async () => {
    const res = await readCsvHead(file(Array.from({ length: 501 }, (_, i) => `c${i}`).join(",") + "\n"));
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/500 columns/) as string });
  });

  it("only reads the start of a big file and says there is more", async () => {
    const line = "abcdefghij,0123456789,klmnopqrst\n";
    const lines = line.repeat(Math.ceil((512 * 1024) / line.length) + 10);
    const res = await readCsvHead(file(lines));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.head.preview.more).toBe(true);
    expect(res.head.preview.rows.every((r) => r.length === 3)).toBe(true);
  });
});
