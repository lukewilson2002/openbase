import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Automation, RunsPage } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { USER, apiError, mockApi, type Handler } from "@/test/utils";
import { PEOPLE } from "@/test/fields";
import { AutomationsPage } from "./AutomationsPage";
import { automationSchema, makeAutomation } from "./testUtils";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const HOUR = 3_600_000;

function run(over: Partial<RunsPage["runs"][number]> = {}): RunsPage["runs"][number] {
  return { id: 1, automation_id: "aut1", status: "succeeded", trigger_data: { type: "record_created" }, log: [], error: null, attempts: 1, created_at: NOW - 2 * HOUR, started_at: NOW - 2 * HOUR, finished_at: NOW - 2 * HOUR + 40, ...over };
}

const noRuns: RunsPage = { runs: [], total: 0 };

function Where() {
  const l = useLocation();
  return <output aria-label="location">{l.pathname}</output>;
}

function renderPage(route: string, role = "creator") {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 0 } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Where />
        <Routes>
          <Route path="/base/:baseId/automations/:automationId?/:tab?" element={<AutomationsPage schema={automationSchema(role)} />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

function routes(list: Automation[], over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": USER,
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: true },
    "GET /api/bases/app1/collaborators": PEOPLE,
    "GET /api/bases/app1/automations": () => list,
    ...Object.fromEntries(list.map((a) => [`GET /api/automations/${a.id}/runs`, noRuns])),
    ...over,
  } satisfies Record<string, Handler>;
}

const first = makeAutomation({ id: "aut1", name: "Copy tasks", enabled: true });
const second = makeAutomation({ id: "aut2", name: "Monday digest", trigger: { type: "schedule", cron: "0 9 * * 1", timezone: "Europe/Berlin" }, actions: [{ type: "notify", user_ids: ["usr1"], message: "hi" }] });

describe("the list", () => {
  it("shows each automation with its trigger, state and last run", async () => {
    mockApi(
      routes([first, second], {
        "GET /api/automations/aut1/runs": { runs: [run({ status: "failed" })], total: 3 },
      }),
    );
    renderPage("/base/app1/automations");
    const list = await screen.findByRole("list", { name: "Automations" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Copy tasks")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("A record is created in Tasks")).toBeInTheDocument();
    expect(await within(rows[0]!).findByText("Failed")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("2 hours ago")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("switch", { name: "Turn off Copy tasks" })).toBeChecked();
    expect(within(rows[1]!).getByText("Every Monday at 09:00 (Europe/Berlin)")).toBeInTheDocument();
    expect(await within(rows[1]!).findByText("Never run")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("switch", { name: "Turn on Monday digest" })).not.toBeChecked();
  });

  it("explains an empty base, mentions the docs and creates the first automation", async () => {
    const created = makeAutomation({ id: "aut9", name: "Hook", trigger: { type: "webhook" }, webhook_token: "ogh_new_token" });
    let stored: Automation[] = [];
    const api = mockApi(
      routes([], {
        "GET /api/bases/app1/automations": () => stored,
        "POST /api/bases/app1/automations": () => {
          stored = [{ ...created, webhook_token: null }];
          return { status: 201, json: created };
        },
        "GET /api/automations/aut9/runs": noRuns,
      }),
    );
    const user = userEvent.setup();
    renderPage("/base/app1/automations");
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
    expect(screen.getAllByText("docs/automations.md").length).toBeGreaterThan(0);
    // Only one "New automation" button while the list is empty.
    await user.click(screen.getByRole("button", { name: /New automation/ }));
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    expect(within(dialog).getByRole("button", { name: "Create automation" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Name"), "Hook");
    await user.selectOptions(within(dialog).getByLabelText("When this happens"), "webhook");
    await user.click(within(dialog).getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/automations")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app1/automations")[0]!.body).toEqual({ name: "Hook", trigger: { type: "webhook" }, actions: [] });
    // It opens in the editor, with the one-time token on show.
    expect(await screen.findByLabelText("Webhook URL")).toHaveValue(`${window.location.origin}/api/hooks/ogh_new_token`);
    expect(screen.getByLabelText("location")).toHaveTextContent("/base/app1/automations/aut9");
  });

  it("creates record triggers on the first table and keeps a server error in the dialog", async () => {
    const api = mockApi(routes([first], { "POST /api/bases/app1/automations": apiError(400, "bad_request", "an automation named that already exists") }));
    const user = userEvent.setup();
    renderPage("/base/app1/automations");
    await user.click(await screen.findByRole("button", { name: /New automation/ }));
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    await user.type(within(dialog).getByLabelText("Name"), "Dup");
    await user.click(within(dialog).getByRole("button", { name: "Create automation" }));
    expect(await within(dialog).findByText("an automation named that already exists")).toBeInTheDocument();
    expect(api.callsTo("POST /api/bases/app1/automations")[0]!.body).toEqual({ name: "Dup", trigger: { type: "record_created", table_id: "tbl1" }, actions: [] });
  });

  it("turns an automation on from the list", async () => {
    const api = mockApi(routes([second], { "PATCH /api/automations/aut2": { ...second, enabled: true } }));
    const user = userEvent.setup();
    renderPage("/base/app1/automations");
    await user.click(await screen.findByRole("switch", { name: "Turn on Monday digest" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/automations/aut2")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/automations/aut2")[0]!.body).toEqual({ enabled: true });
  });

  it("tells you when the server refuses to turn one on", async () => {
    mockApi(routes([first], { "PATCH /api/automations/aut1": apiError(400, "bad_request", "add at least one action before turning the automation on") }));
    const user = userEvent.setup();
    renderPage("/base/app1/automations");
    await user.click(await screen.findByRole("switch", { name: "Turn off Copy tasks" }));
    expect(await screen.findByText("Could not turn the automation off")).toBeInTheDocument();
  });

  it("renames from the menu", async () => {
    const api = mockApi(routes([first], { "PATCH /api/automations/aut1": { ...first, name: "Better name" } }));
    const user = userEvent.setup();
    renderPage("/base/app1/automations");
    await user.click(await screen.findByRole("button", { name: "Options for Copy tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename automation" });
    const input = within(dialog).getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Better name");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/automations/aut1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/automations/aut1")[0]!.body).toEqual({ name: "Better name" });
  });

  it("deletes after confirming and leaves the deleted automation's page", async () => {
    let remaining = [first, second];
    const api = mockApi(
      routes([], {
        "GET /api/bases/app1/automations": () => remaining,
        "GET /api/automations/aut1/runs": noRuns,
        "GET /api/automations/aut2/runs": noRuns,
        "DELETE /api/automations/aut1": () => {
          remaining = [second];
          return { ok: true };
        },
      }),
    );
    const user = userEvent.setup();
    renderPage("/base/app1/automations/aut1");
    await screen.findByRole("heading", { name: /Automations/ });
    await user.click(await screen.findByRole("button", { name: "Options for Copy tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/run history are deleted for good/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/automations/aut1")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Copy tasks")).not.toBeInTheDocument());
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/base\/app1\/automations$/);
  });
});

describe("routes and roles", () => {
  it("opens the editor for the automation in the URL, and its Runs tab under /runs", async () => {
    mockApi(routes([first], { "GET /api/automations/aut1/runs": { runs: [run({ id: 7 })], total: 1 } }));
    const user = userEvent.setup();
    renderPage("/base/app1/automations/aut1");
    expect(await screen.findByLabelText("Name")).toHaveValue("Copy tasks");
    expect(screen.getByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Runs" }));
    expect(screen.getByLabelText("location")).toHaveTextContent("/base/app1/automations/aut1/runs");
    expect(await screen.findByRole("list", { name: "Runs" })).toBeInTheDocument();
  });

  it("says so when the automation in the URL does not exist", async () => {
    mockApi(routes([first]));
    renderPage("/base/app1/automations/gone");
    expect(await screen.findByText("Automation not found")).toBeInTheDocument();
  });

  it("is for creators: an editor gets an explanation and no requests for the list", async () => {
    const api = mockApi(routes([first]));
    renderPage("/base/app1/automations", "editor");
    expect(await screen.findByText("Automations are for creators")).toBeInTheDocument();
    expect(api.callsTo("GET /api/bases/app1/automations")).toHaveLength(0);
  });

  it("shows an error with retry when the list cannot be loaded", async () => {
    mockApi(routes([], { "GET /api/bases/app1/automations": apiError(500, "internal", "database is locked") }));
    renderPage("/base/app1/automations");
    expect(await screen.findByText(/database is locked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("takes the email setting from the server", async () => {
    mockApi(
      routes([{ ...makeAutomation({ id: "aut3", name: "Mail", actions: [{ type: "send_email", to: "a@b.co", subject: "s", body: "b" }] }) }], {
        "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false },
      }),
    );
    renderPage("/base/app1/automations/aut3");
    expect(await screen.findByText(/Email is not configured on this server/)).toBeInTheDocument();
  });
});
