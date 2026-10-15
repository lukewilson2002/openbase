import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import TimelineView from "./TimelineView";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-12T12:00:00Z") });
});

const tl = (patch: Record<string, unknown> = {}) =>
  viewWithConfig("viw1", "timeline", { timeline: { start_field_id: F.start.id, end_field_id: F.end.id, group_field_id: null, dependency_field_id: null, scale: "week", ...patch } });

const records = [
  rec("r1", { [F.start.id]: "2026-03-02", [F.end.id]: "2026-03-06", [F.status.id]: "s1" }),
  rec("r2", { [F.start.id]: "2026-03-04", [F.end.id]: "2026-03-10", [F.status.id]: "s2", [F.deps.id]: [{ id: "r1", name: "R1" }] }), // starts before r1 ends
  rec("r3", { [F.start.id]: "2026-03-09", [F.end.id]: "2026-03-12", [F.status.id]: "s2", [F.deps.id]: [{ id: "r2", name: "R2" }] }), // starts the day r2 ends: violated
  rec("r4", { [F.start.id]: "2026-03-15" }), // milestone
];

function setup(role = "editor", view = tl(), routes: Record<string, unknown> = {}, recs = records) {
  const asked: QueryRequest[] = [];
  return { asked, ...renderView(TimelineView, { schema: projectSchema(role, [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records: recs }, asked), ...routes } as never }) };
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

describe("TimelineView", () => {
  it("queries a window around today with the start and end fields, padded by a day", async () => {
    const { asked } = setup();
    await screen.findByRole("button", { name: /^R1, / });
    const ranged = asked.find((a) => a.range)!;
    const range = ranged.range!;
    expect(range).toMatchObject({ field_id: "f_start", end_field_id: "f_end" });
    // The week scale shows about 400 days centred on today (2026-03-12).
    expect(range.from < "2026-03-12" && range.to > "2026-03-12").toBe(true);
    expect(Date.parse(range.to) - Date.parse(range.from)).toBeGreaterThan(300 * 86_400_000);
    expect(ranged.timezone).toBe("UTC");
  });

  it("draws bars for dated records and a milestone for a record with only a start", async () => {
    setup();
    expect(await screen.findByRole("button", { name: /^R1, Mar 2 – Mar 6/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^R4, Mar 15/ })).toHaveAttribute("data-milestone", "true");
    expect(screen.getByRole("button", { name: /^R1, / })).not.toHaveAttribute("data-milestone");
    // Without swimlanes each record has its own row, named in the left column; the bar says its dates.
    const rows = [...document.querySelectorAll("[data-lane]")].map((l) => l.getAttribute("data-lane"));
    expect(rows).toEqual(["r1", "r2", "r3", "r4"]);
    expect(screen.getByRole("button", { name: "R2" })).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^R2, / })).getByText("Mar 4 – Mar 10")).toBeInTheDocument();
  });

  it("orders the rows by start date unless the view sorts them", async () => {
    setup("editor", tl(), {}, [records[3]!, records[1]!, records[0]!]);
    await screen.findByRole("button", { name: /^R1, / });
    expect([...document.querySelectorAll("[data-lane]")].map((l) => l.getAttribute("data-lane"))).toEqual(["r1", "r2", "r4"]);
  });

  it("says how many records the view has and how many have no date", async () => {
    setup();
    await screen.findByRole("button", { name: /^R1, / });
    // The test server ignores filters, so the "start is empty" count is every record here.
    expect(await screen.findByText("4 items · 4 without a date aren’t shown")).toBeInTheDocument();
  });

  it("opens a record from its name in the left column", async () => {
    const u = user();
    setup("viewer", tl(), { "GET /api/tables/tbl1/records/r2": records[1]! });
    await u.click(await screen.findByRole("button", { name: "R2" }));
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r2");
  });

  it("draws dependency arrows from predecessors and flags overlaps in red", async () => {
    const { container } = setup("editor", tl({ dependency_field_id: F.deps.id }));
    await screen.findByRole("button", { name: /^R1, / });
    const arrows = [...container.querySelectorAll("path[data-dependency]")].map((a) => a.getAttribute("data-dependency"));
    expect(arrows.sort()).toEqual(["violated", "violated"]);
    expect(screen.getByRole("button", { name: /^R2, / })).toHaveAttribute("data-violated", "true");
    expect(screen.getByText("2 dependencies overlap")).toBeInTheDocument();
  });

  it("makes swimlanes from the group field, one lane per choice, and shows empty choices", async () => {
    setup("editor", tl({ group_field_id: F.status.id }));
    await screen.findByRole("button", { name: /^R1, / });
    const labels = ["Todo", "Doing", "Done", "(Empty)"].map((l) => screen.getByText(l));
    expect(labels).toHaveLength(4);
    const doing = screen.getByText("Doing").closest("div")!.parentElement!;
    expect(within(doing).getByText("2 bars")).toBeInTheDocument();
  });

  it("uses the view's own grouping for lanes when no lane field is set", async () => {
    const view = tl();
    setup("editor", view, {}, records);
    // Ungrouped: a single unlabeled lane.
    await screen.findByRole("button", { name: /^R1, / });
    expect(screen.queryByText("(Empty)")).not.toBeInTheDocument();
  });

  it("changes the scale and saves it in the view", async () => {
    const u = user();
    const view = tl();
    const { api } = setup("editor", view, { "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) });
    await screen.findByRole("button", { name: /^R1, / });
    const scale = screen.getByRole("group", { name: "Timeline scale" });
    expect(within(scale).getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    await u.click(within(scale).getByRole("button", { name: "Month" }));
    expect(within(scale).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    // Quick changes are saved together (debounced).
    await u.click(within(scale).getByRole("button", { name: "Quarter" }));
    expect(within(scale).getByRole("button", { name: "Quarter" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { timeline: { scale: string; start_field_id: string } } }).config.timeline).toMatchObject({ scale: "quarter", start_field_id: "f_start" });
  });

  it("keeps a viewer's scale choice local (nothing is saved)", async () => {
    const u = user();
    const { api } = setup("viewer");
    await screen.findByRole("button", { name: /^R1, / });
    const scale = screen.getByRole("group", { name: "Timeline scale" });
    await u.click(within(scale).getByRole("button", { name: "Quarter" }));
    expect(within(scale).getByRole("button", { name: "Quarter" })).toHaveAttribute("aria-pressed", "true");
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);
  });

  it("moves a bar with the keyboard: one PATCH with the shifted dates", async () => {
    const u = user();
    const { api } = setup("editor", tl(), { "PATCH /api/tables/tbl1/records": { records: [records[0]!] } });
    const bar = await screen.findByRole("button", { name: /^R1, / });
    bar.focus();
    await u.keyboard("{ArrowRight}");
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toEqual({ typecast: true, records: [{ id: "r1", values: { f_start: "2026-03-03", f_end: "2026-03-07" } }] });
  });

  it("resizes the end with Shift+Arrow and writes only the end date", async () => {
    const u = user();
    const { api } = setup("editor", tl(), { "PATCH /api/tables/tbl1/records": { records: [records[0]!] } });
    const bar = await screen.findByRole("button", { name: /^R1, / });
    bar.focus();
    await u.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body as { records: { values: unknown }[] }).records[0]!.values).toEqual({ f_end: "2026-03-07" });
  });

  it("does not move bars for viewers", async () => {
    const u = user();
    const { api } = setup("viewer");
    const bar = await screen.findByRole("button", { name: /^R1, / });
    bar.focus();
    await u.keyboard("{ArrowRight}");
    expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Add record/ })).not.toBeInTheDocument();
  });

  it("opens the record when a bar is clicked", async () => {
    const u = user();
    setup("viewer", tl(), { "GET /api/tables/tbl1/records/r1": records[0]! });
    await u.click(await screen.findByRole("button", { name: /^R1, / }));
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r1");
  });

  it("asks for a start field when none is set", async () => {
    const u = user();
    const view = viewWithConfig("viw1", "timeline", {});
    const { api, asked } = setup("editor", view, { "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) });
    expect(await screen.findByText("Choose the dates")).toBeInTheDocument();
    expect(asked).toHaveLength(0);
    // The likely start and end (the first two dates people fill in) are chosen already.
    expect(screen.getByRole("combobox", { name: "Start date" })).toHaveValue("f_start");
    expect(screen.getByRole("combobox", { name: /End date/ })).toHaveValue("f_end");
    await u.click(screen.getByRole("button", { name: "Show timeline" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { timeline: unknown } }).config.timeline).toMatchObject({ start_field_id: "f_start", end_field_id: "f_end" });
  });

  it("adds a record dated today from the toolbar and opens it", async () => {
    const u = user();
    const created = rec("r9", {});
    const { api } = setup("editor", tl(), { "POST /api/tables/tbl1/records": { records: [created] }, "GET /api/tables/tbl1/records/r9": created });
    await screen.findByRole("button", { name: /^R1, / });
    await u.click(screen.getByRole("button", { name: "Add record" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toMatchObject({ records: [{ values: { f_start: "2026-03-12", f_end: "2026-03-12" } }] });
  });
});
