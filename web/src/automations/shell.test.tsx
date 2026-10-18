/** The automations page inside the real route table and base shell. */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER, makeWorkspace, mockApi, renderApp, stubDesktop } from "@/test/utils";
import { PEOPLE } from "@/test/fields";
import { automationSchema, makeAutomation } from "./testUtils";

vi.mock("@/views/grid/GridView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  return { default: PlaceholderView };
});

afterEach(() => vi.unstubAllGlobals());

function open(role: string, route: string) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false },
    "GET /api/workspaces": [makeWorkspace(role, [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role, people: [], tables: [] }])],
    "GET /api/bases/app1": automationSchema(role),
    "GET /api/bases/app1/collaborators": PEOPLE,
    "GET /api/bases/app1/automations": [makeAutomation({ name: "Copy tasks" })],
    "GET /api/automations/aut1/runs": { runs: [], total: 0 },
  }) && renderApp({ route });
}

describe("automations in the base shell", () => {
  // The links live in the menu tree, docked from tablet width up (a drawer on phones).
  beforeEach(() => stubDesktop());

  it("is reached from the project in the menu by creators, keeps the tables listed and does not mistake the path for a table", async () => {
    const user = userEvent.setup();
    open("creator", "/base/app1/tbl1/viw1");
    await screen.findByText("Grid view coming soon");
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    await user.click(within(menu).getByRole("link", { name: "Automations" }));
    expect(await screen.findByRole("list", { name: "Automations" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Automations" })).toBeInTheDocument();
    expect(within(menu).getByRole("link", { name: "Automations" })).toHaveAttribute("aria-current", "page");
    // The tables stay in the menu, as a way back.
    const tabs = within(menu).getByRole("list", { name: "Tables in Project tracker" });
    expect(within(tabs).getByRole("link", { name: "Tasks" })).not.toHaveAttribute("aria-current");
    await user.click(within(tabs).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByText("Grid view coming soon")).toBeInTheDocument();
  });

  it("opens an automation straight from its URL", async () => {
    open("owner", "/base/app1/automations/aut1");
    expect(await screen.findByLabelText("Name")).toHaveValue("Copy tasks");
  });

  it("is not offered to editors, and the URL explains why", async () => {
    open("editor", "/base/app1/automations");
    expect(await screen.findByText("Automations are for creators")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
  });

  it("is not offered to viewers either", async () => {
    open("viewer", "/base/app1/tbl1/viw1");
    await screen.findByText("Grid view coming soon");
    expect(screen.queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
  });
});
