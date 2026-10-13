import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER, apiError, makeSchema, mockApi, renderApp } from "@/test/utils";

// These tests are about the shell (tabs, sidebar, permissions). The real grid draws on a canvas
// and has its own tests under src/views/grid, so the shell tests render the placeholder for it.
vi.mock("@/views/grid/GridView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  const { useSearchParams } = await import("react-router");
  // Shows the ?record= parameter so tests can see whether the shell's redirects keep it.
  function Stub(props: Parameters<typeof PlaceholderView>[0]) {
    const [params] = useSearchParams();
    return (
      <>
        <PlaceholderView {...props} />
        <output data-testid="record-param">{params.get("record")}</output>
      </>
    );
  }
  return { default: Stub };
});

// Same for the kanban view (its own tests live in src/views/kanban).
vi.mock("@/views/kanban/KanbanView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  return { default: PlaceholderView };
});

afterEach(() => vi.unstubAllGlobals());

function openBase(role: string, extra: Record<string, unknown> = {}, route = "/base/app1") {
  const api = mockApi({
    "GET /api/auth/me": USER,
    "GET /api/bases/app1": makeSchema(role),
    ...extra,
  });
  renderApp({ route });
  return api;
}

describe("base shell", () => {
  it("canonicalises the URL and renders the first view through the registry", async () => {
    openBase("owner");
    expect(await screen.findByText("Grid view coming soon")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All tasks" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
  });

  it("switches views and renders the placeholder for each view type", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("link", { name: "Board" }));
    expect(await screen.findByText("Kanban view coming soon")).toBeInTheDocument();
  });

  it("switches tables", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("link", { name: "People" }));
    expect(await screen.findByRole("link", { name: "Everyone" })).toHaveAttribute("aria-current", "page");
  });

  it("shows personal views in their own list, marked as personal", async () => {
    openBase("editor");
    await screen.findByText("Grid view coming soon");
    const personal = screen.getByRole("list", { name: "Personal views" });
    expect(within(personal).getByRole("link", { name: /My tasks/ })).toBeInTheDocument();
    expect(within(personal).getByRole("img", { name: "Personal view" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Shared views" })).queryByText("My tasks")).not.toBeInTheDocument();
  });

  it("explains a missing base", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/bases/app1": apiError(404, "not_found", "base not found") });
    renderApp({ route: "/base/app1" });
    expect(await screen.findByText("Base not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to all bases" })).toBeInTheDocument();
  });

  describe("viewer", () => {
    it("cannot add tables, create views, rename the base or manage views and tables", async () => {
      openBase("viewer");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: "Add table" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Table options/ })).not.toBeInTheDocument();
      expect(screen.queryByText("Create view")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Options for/ })).not.toBeInTheDocument();
      expect(screen.queryByTitle("Rename base")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Project tracker", level: 1 })).toBeInTheDocument();
    });

    it("sees members but not invite controls in the share dialog", async () => {
      const user = userEvent.setup();
      openBase("viewer", {
        "GET /api/bases/app1/members": [{ user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "viewer" }],
      });
      await user.click(await screen.findByRole("button", { name: /Share/ }));
      const dialog = await screen.findByRole("dialog", { name: "Share Project tracker" });
      expect(await within(dialog).findByText("Ada Lovelace")).toBeInTheDocument();
      expect(within(dialog).queryByLabelText("Role for Ada Lovelace")).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: /Create invite link/ })).not.toBeInTheDocument();
      expect(within(dialog).getByText(/Only creators and owners can change members/)).toBeInTheDocument();
    });
  });

  describe("editor", () => {
    it("can create personal views only and cannot change tables or shared views", async () => {
      const user = userEvent.setup();
      const api = openBase("editor", {
        "POST /api/tables/tbl1/views": (call: { body: unknown }) => ({ id: "viw9", table_id: "tbl1", name: (call.body as { name: string }).name, type: "calendar", personal: true, locked: false, config: {} }),
      });
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: "Add table" })).not.toBeInTheDocument();
      expect(screen.getByText(/Editors can create personal views/)).toBeInTheDocument();
      expect(screen.queryByTitle("Rename base")).not.toBeInTheDocument();
      // Shared views are creator territory; the editor's own personal view is manageable.
      expect(screen.queryByRole("button", { name: "Options for All tasks" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Options for My tasks" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Calendar" }));
      const dialog = await screen.findByRole("dialog", { name: "New calendar view" });
      expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("Name")).toHaveValue("Calendar view");
      await user.click(within(dialog).getByRole("button", { name: "Create view" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views")).toHaveLength(1));
      expect(api.callsTo("POST /api/tables/tbl1/views")[0]?.body).toEqual({ name: "Calendar view", type: "calendar", personal: true, config: null });
    });
  });

  describe("importing CSV", () => {
    it("lets editors import into a table but not rename, duplicate or delete it", async () => {
      const user = userEvent.setup();
      openBase("editor");
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
      expect(await screen.findByRole("menuitem", { name: /Import CSV/ })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Rename table" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Delete table" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: /Import CSV/ }));
      expect(await screen.findByRole("dialog", { name: "Import CSV into Tasks" })).toBeInTheDocument();
    });

    it("keeps viewers and commenters out of it", async () => {
      openBase("commenter");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: /Table options/ })).not.toBeInTheDocument();
    });

    it("offers creators a new table from CSV next to the empty one", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Add table" }));
      expect(await screen.findByRole("menuitem", { name: "New empty table" })).toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: /New table from CSV/ }));
      expect(await screen.findByRole("dialog", { name: "New table from CSV" })).toBeInTheDocument();
    });
  });

  describe("creator", () => {
    it("can manage tables, rename the base and create each of the seven view types", async () => {
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      expect(screen.getByRole("button", { name: "Add table" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Table options for Tasks" })).toBeInTheDocument();
      expect(screen.getByTitle("Rename base")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Options for All tasks" })).toBeInTheDocument();
      const creators = screen.getByText("Create view").parentElement!;
      for (const label of ["Grid", "Form", "Gallery", "Kanban", "Calendar", "Timeline", "List"]) {
        expect(within(creators).getByRole("button", { name: label })).toBeInTheDocument();
      }
    });

    it("creates a shared view, with the personal option unchecked by default", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "POST /api/tables/tbl1/views": { id: "viw9", table_id: "tbl1", name: "Sprint board", type: "kanban", personal: false, locked: false, config: {} },
      });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Kanban" }));
      const dialog = await screen.findByRole("dialog", { name: "New kanban view" });
      expect(within(dialog).getByRole("checkbox", { name: /Personal view/ })).not.toBeChecked();
      const name = within(dialog).getByLabelText("Name");
      await user.clear(name);
      await user.type(name, "Sprint board");
      await user.click(within(dialog).getByRole("button", { name: "Create view" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views")).toHaveLength(1));
      expect(api.callsTo("POST /api/tables/tbl1/views")[0]?.body).toEqual({ name: "Sprint board", type: "kanban", personal: false, config: null });
    });

    it("locks a view from its menu", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "PATCH /api/views/viw1": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Options for All tasks" }));
      await user.click(await screen.findByRole("menuitem", { name: "Lock view" }));
      await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/views/viw1")[0]?.body).toEqual({ locked: true });
    });

    it("does not offer locking for personal views", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Options for My tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Rename view" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /Lock view/ })).not.toBeInTheDocument();
    });

    it("renames the base inline", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "PATCH /api/bases/app1": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByTitle("Rename base"));
      const input = screen.getByRole("textbox", { name: "Base name" });
      await user.clear(input);
      await user.type(input, "Renamed{Enter}");
      await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ name: "Renamed" });
    });

    it("adds a table and opens it", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "POST /api/bases/app1/tables": { id: "tbl9", base_id: "app1", name: "Projects", description: null, primary_field_id: "f", fields: [], views: [] },
      });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Add table" }));
      await user.click(await screen.findByRole("menuitem", { name: "New empty table" }));
      await user.type(await screen.findByLabelText("Name"), "Projects");
      await user.click(screen.getByRole("button", { name: "Create table" }));
      await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables")).toHaveLength(1));
      expect(api.callsTo("POST /api/bases/app1/tables")[0]?.body).toEqual({ name: "Projects" });
    });

    it("cannot delete the last remaining view or table", async () => {
      const user = userEvent.setup();
      const schema = makeSchema("creator");
      schema.tables = [{ ...schema.tables[0]!, views: [schema.tables[0]!.views[0]!] }];
      mockApi({ "GET /api/auth/me": USER, "GET /api/bases/app1": schema });
      renderApp({ route: "/base/app1" });
      await screen.findByText("Grid view coming soon");

      await user.click(screen.getByRole("button", { name: "Options for All tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Delete view" })).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Delete table" })).toHaveAttribute("aria-disabled", "true");
    });

    it("manages members and invites at base level", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "GET /api/bases/app1/members": [{ user_id: "usr2", name: "Grace Hopper", email: "grace@example.com", role: "commenter" }],
        "GET /api/bases/app1/invites": [{ id: "inv1", workspace_id: null, base_id: "app1", email: "kim@example.com", role: "viewer", created_at: 1, expires_at: 1_900_000_000_000, accepted_at: null }],
        "DELETE /api/invites/inv1": { status: 204 },
      });
      await user.click(await screen.findByRole("button", { name: /Share/ }));
      const dialog = await screen.findByRole("dialog", { name: "Share Project tracker" });
      // A creator may grant up to creator, never owner.
      const roleSelect = await within(dialog).findByLabelText("Role for Grace Hopper");
      const options = within(roleSelect).getAllByRole("option").map((o) => o.textContent);
      expect(options).toEqual(["Viewer", "Commenter", "Editor", "Creator"]);
      await user.click(await within(dialog).findByRole("button", { name: "Revoke invite" }));
      await waitFor(() => expect(api.callsTo("DELETE /api/invites/inv1")).toHaveLength(1));
    });
  });
});

describe("top bar additions", () => {
  it("shows the notification bell to everyone and the trash to creators only", async () => {
    openBase("viewer", { "GET /api/notifications": { notifications: [], unread: 2 } });
    await screen.findByText("Grid view coming soon");
    expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trash" })).not.toBeInTheDocument();
  });

  it("opens the trash of the base for a creator", async () => {
    const user = userEvent.setup();
    openBase("creator", { "GET /api/bases/app1/trash": { items: [{ kind: "table", id: "tbl9", name: "Old budget", table_id: null, deleted_at: Date.now() - 86_400_000 }] } });
    await user.click(await screen.findByRole("button", { name: "Trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Trash" });
    expect(await within(dialog).findByText("Old budget")).toBeInTheDocument();
  });

  it("keeps ?record= when it canonicalises a link such as a notification's", async () => {
    openBase("owner", {}, "/base/app1/tbl1?record=rec1");
    expect(await screen.findByTestId("record-param")).toHaveTextContent("rec1");
    expect(screen.getByRole("link", { name: "All tasks" })).toHaveAttribute("aria-current", "page");
  });
});
