import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationRun, RunsPage } from "@/api/types";
import { apiError, mockApi } from "@/test/utils";
import { RunsTab } from "./RunsTab";
import { renderWithEnv } from "./testUtils";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const MIN = 60_000;

function run(id: number, over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id,
    automation_id: "aut1",
    status: "succeeded",
    trigger_data: { type: "record_created", time: "t", record: { id: "recAAA", table_id: "tbl1", fields: {} } },
    log: [{ index: 0, action: "create_record", status: "succeeded", attempt: 1, output: { record_id: "recBBB", table_id: "tbl2" }, error: null, duration_ms: 12 }],
    error: null,
    attempts: 1,
    created_at: NOW - 5 * MIN,
    started_at: NOW - 5 * MIN,
    finished_at: NOW - 5 * MIN + 1500,
    ...over,
  };
}

const RUNS = "GET /api/automations/aut1/runs";

function renderTab(enabled = true) {
  return renderWithEnv(<RunsTab automation={{ id: "aut1", enabled }} timeZone="UTC" />);
}

describe("RunsTab", () => {
  it("lists runs newest first with status, trigger, start and duration", async () => {
    mockApi({
      [RUNS]: {
        runs: [run(3, { status: "failed", error: "boom", trigger_data: { type: "webhook", test: true } }), run(2, { status: "running", finished_at: null }), run(1)],
        total: 3,
      } satisfies RunsPage,
    });
    renderTab();
    const list = await screen.findByRole("list", { name: "Runs" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Webhook")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("test")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Running")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Succeeded")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Record created")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("recAAA")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Started 5 minutes ago")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("1.5 s")).toBeInTheDocument();
    expect(screen.getByText(/3 runs, newest first/)).toBeInTheDocument();
  });

  it("expands a run into its step log, output and error", async () => {
    mockApi({
      [RUNS]: {
        runs: [
          run(5, {
            status: "failed",
            attempts: 3,
            error: "step 2 failed",
            log: [
              { index: 0, action: "create_record", status: "succeeded", attempt: 1, output: { record_id: "recBBB" }, duration_ms: 12 },
              { index: 1, action: "http_request", status: "failed", attempt: 3, error: "connection refused", duration_ms: 1200, output: null },
              { index: 2, action: "notify", status: "skipped", attempt: 1, duration_ms: 0 },
            ],
          }),
        ],
        total: 1,
      },
    });
    const user = userEvent.setup();
    renderTab();
    const row = (await screen.findByRole("list", { name: "Runs" })).querySelector("li")!;
    const toggle = within(row).getByRole("button", { expanded: false });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const log = within(row).getByRole("list", { name: "Step log" });
    const steps = within(log).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(within(steps[0]!).getByText("Step 1: create record")).toBeInTheDocument();
    expect(within(steps[0]!).getByText("Succeeded")).toBeInTheDocument();
    expect(within(steps[0]!).getByText("12 ms")).toBeInTheDocument();
    expect(within(steps[1]!).getByText("connection refused")).toBeInTheDocument();
    expect(within(steps[1]!).getByText("attempt 3")).toBeInTheDocument();
    expect(within(steps[2]!).getByText("Skipped")).toBeInTheDocument();
    expect(within(row).getByText("step 2 failed")).toBeInTheDocument();
    // The output sits in a disclosure.
    await user.click(within(steps[0]!).getByText("Output"));
    expect(within(steps[0]!).getByText(/"record_id": "recBBB"/)).toBeInTheDocument();
    // The trigger data is available too.
    expect(within(row).getByText("Trigger data")).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("pages with next_before and appends the older runs", async () => {
    const api = mockApi({
      [RUNS]: (call: { query: URLSearchParams }) => {
        const before = call.query.get("before");
        return before === "21" ? { runs: [run(20), run(19)], total: 4 } : { runs: [run(22), run(21)], total: 4, next_before: 21 };
      },
    });
    const user = userEvent.setup();
    renderTab();
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
    expect(api.callsTo(RUNS)[0]!.query.get("limit")).toBe("20");
    expect(api.callsTo(RUNS)[0]!.query.has("before")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Load older runs" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
    expect(api.callsTo(RUNS).at(-1)!.query.get("before")).toBe("21");
    expect(screen.queryByRole("button", { name: "Load older runs" })).not.toBeInTheDocument();
  });

  it("explains an empty history differently for on and off automations", async () => {
    mockApi({ [RUNS]: { runs: [], total: 0 } });
    const on = renderTab(true);
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByText(/appear here a moment after the trigger fires/)).toBeInTheDocument();
    on.unmount();
    renderTab(false);
    expect(await screen.findByText(/This automation is off, so it never runs/)).toBeInTheDocument();
  });

  it("shows an error with retry", async () => {
    let fail = true;
    mockApi({ [RUNS]: () => (fail ? apiError(500, "internal", "database is locked") : { runs: [run(1)], total: 1 }) });
    const user = userEvent.setup();
    renderTab();
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Runs" })).toBeInTheDocument();
  });

  it("refreshes on request", async () => {
    const api = mockApi({ [RUNS]: { runs: [run(1)], total: 1 } });
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("list", { name: "Runs" });
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.callsTo(RUNS).length).toBeGreaterThanOrEqual(2));
  });
});
