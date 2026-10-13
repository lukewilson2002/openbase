import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestResult, Trigger } from "@/api/types";
import { apiError, mockApi } from "@/test/utils";
import { TestPanel, buildTestRequest } from "./TestPanel";
import { renderWithEnv } from "./testUtils";

afterEach(() => vi.unstubAllGlobals());

const TEST = "POST /api/automations/aut1/test";

const dry: TestResult = {
  dry_run: true,
  status: "succeeded",
  log: [
    { index: 0, action: "create_record", status: "succeeded", attempt: 1, output: { dry_run: true, values: { Name: "Alpha" } }, duration_ms: 1 },
    { index: 1, action: "notify", status: "skipped", attempt: 1, duration_ms: 0 },
  ],
};

function renderPanel(trigger: Trigger = { type: "record_created", table_id: "tbl1" }, dirty = false) {
  return renderWithEnv(<TestPanel automationId="aut1" trigger={trigger} dirty={dirty} />);
}

describe("buildTestRequest", () => {
  it("is a dry run by default and adds the record id for record triggers only", () => {
    expect(buildTestRequest("record", { real: false, recordId: "", body: "{}" })).toEqual({ dry_run: true });
    expect(buildTestRequest("record", { real: false, recordId: " recX ", body: "{}" })).toEqual({ dry_run: true, record_id: "recX" });
    expect(buildTestRequest("schedule", { real: false, recordId: "recX", body: "{}" })).toEqual({ dry_run: true });
  });

  it("sends the parsed sample body for webhooks and refuses invalid JSON", () => {
    expect(buildTestRequest("webhook", { real: true, recordId: "", body: '{"sku": "A1", "qty": 2}' })).toEqual({ dry_run: false, body: { sku: "A1", qty: 2 } });
    expect(buildTestRequest("webhook", { real: false, recordId: "", body: "  " })).toEqual({ dry_run: true });
    expect(() => buildTestRequest("webhook", { real: false, recordId: "", body: "{oops" })).toThrow(/not valid JSON/);
  });
});

describe("TestPanel", () => {
  it("runs a dry run by default and shows the step log", async () => {
    const api = mockApi({ [TEST]: dry });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Test (dry run)" }));
    const result = await screen.findByRole("region", { name: "Test result" });
    expect(api.callsTo(TEST)[0]!.body).toEqual({ dry_run: true });
    expect(within(result).getByText(/Dry run: nothing was written, sent or requested/)).toBeInTheDocument();
    const steps = within(result).getAllByRole("listitem");
    expect(within(steps[0]!).getByText("Step 1: create record")).toBeInTheDocument();
    expect(within(steps[1]!).getByText("Skipped")).toBeInTheDocument();
  });

  it("uses the given record id", async () => {
    const api = mockApi({ [TEST]: dry });
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText("Record id (optional)"), "recXYZ");
    await user.click(screen.getByRole("button", { name: "Test (dry run)" }));
    await screen.findByRole("region", { name: "Test result" });
    expect(api.callsTo(TEST)[0]!.body).toEqual({ dry_run: true, record_id: "recXYZ" });
  });

  it("sends the sample body of a webhook test, and rejects bad JSON without calling the server", async () => {
    const api = mockApi({ [TEST]: dry });
    const user = userEvent.setup();
    renderPanel({ type: "webhook" });
    const body = screen.getByLabelText("Sample webhook body (JSON)");
    fireEvent.change(body, { target: { value: "{oops" } });
    await user.click(screen.getByRole("button", { name: "Test (dry run)" }));
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(api.callsTo(TEST)).toHaveLength(0);
    fireEvent.change(body, { target: { value: '{"name": "Ada"}' } });
    await user.click(screen.getByRole("button", { name: "Test (dry run)" }));
    await screen.findByRole("region", { name: "Test result" });
    expect(api.callsTo(TEST)[0]!.body).toEqual({ dry_run: true, body: { name: "Ada" } });
  });

  it("asks for confirmation before running for real, then records the run", async () => {
    const api = mockApi({ [TEST]: { dry_run: false, status: "succeeded", log: dry.log, run_id: 12 } });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("checkbox", { name: /Run for real/ }));
    await user.click(screen.getByRole("button", { name: "Run for real" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/records are created or changed, emails are sent and HTTP requests are made/)).toBeInTheDocument();
    expect(api.callsTo(TEST)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Run for real" }));
    expect(await screen.findByText(/Real run, recorded as run #12/)).toBeInTheDocument();
    expect(api.callsTo(TEST)[0]!.body).toEqual({ dry_run: false });
  });

  it("does not run for real when the confirmation is cancelled", async () => {
    const api = mockApi({ [TEST]: dry });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("checkbox", { name: /Run for real/ }));
    await user.click(screen.getByRole("button", { name: "Run for real" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.callsTo(TEST)).toHaveLength(0);
  });

  it("shows a failed run with its error and failed step", async () => {
    mockApi({
      [TEST]: { dry_run: false, status: "failed", error: "step 1 failed", log: [{ index: 0, action: "http_request", status: "failed", attempt: 1, error: "refused", duration_ms: 3 }], run_id: 4 } satisfies TestResult,
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Test (dry run)" }));
    const result = await screen.findByRole("region", { name: "Test result" });
    expect(within(result).getAllByText("Failed")).toHaveLength(2); // the run and the step
    expect(within(result).getByText("step 1 failed")).toBeInTheDocument();
    expect(within(result).getByText("refused")).toBeInTheDocument();
  });

  it("shows the server's message when the test cannot start", async () => {
    mockApi({ [TEST]: apiError(400, "bad_request", "the trigger table has no records to test with") });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Test (dry run)" }));
    expect(await screen.findByText("the trigger table has no records to test with")).toBeInTheDocument();
  });

  it("is disabled while there are unsaved changes, because the server tests the saved version", () => {
    renderPanel({ type: "record_created", table_id: "tbl1" }, true);
    expect(screen.getByRole("button", { name: "Test (dry run)" })).toBeDisabled();
    expect(screen.getByText(/Save your changes first/)).toBeInTheDocument();
  });
});
