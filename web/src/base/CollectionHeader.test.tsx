import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BaseSchema, Table } from "@/api/types";
import { USER, makeSchema, makeWorkspace, mockApi, renderWithProviders, stubDesktop, stubPhone } from "@/test/utils";
import { SearchBarProvider } from "@/shell/SearchEverything";
import { AddRecordProvider, useRegisterAddRecord } from "@/views/common/addRecord";
import { CollectionHeader, recordsCount } from "./CollectionHeader";

/** A layout that can add: what the open view registers while it is on screen. */
function CanAdd({ onAdd }: { onAdd: () => void }) {
  useRegisterAddRecord(onAdd);
  return null;
}

interface Opts {
  phone?: boolean;
  schema?: BaseSchema;
  table?: Partial<Table>;
  /** What the sidebar's list says the collection holds. */
  listed?: number;
  onAdd?: () => void;
  section?: "automations";
  routes?: Record<string, unknown>;
}

function renderHeader(role: string, { phone = false, schema: given, table: over, listed, onAdd, section, routes }: Opts = {}) {
  if (phone) stubPhone();
  else stubDesktop();
  const base = given ?? makeSchema(role);
  const table = { ...base.tables[0]!, ...over };
  const schema = { ...base, tables: [table, ...base.tables.slice(1)] };
  const api = mockApi({
    "GET /api/auth/me": USER,
    "GET /api/workspaces": [makeWorkspace(role, [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role, is_top_level: !!schema.is_top_level, people: [], tables: [{ id: table.id, name: table.name, color: table.color, record_count: listed ?? table.record_count, body_field_id: null, home_date_field_id: null, done_field_id: null, record_noun: table.record_noun }] }])],
    ...routes,
  } as never);
  const onShare = vi.fn();
  const onSettings = vi.fn();
  renderWithProviders(
    <SearchBarProvider>
      <AddRecordProvider>
        {onAdd && <CanAdd onAdd={onAdd} />}
        <main>
          <CollectionHeader schema={schema} table={section ? undefined : table} section={section} onShare={onShare} onSettings={onSettings} />
        </main>
      </AddRecordProvider>
    </SearchBarProvider>,
  );
  return { api, onShare, onSettings, table, schema };
}

const header = () => document.querySelector("header")!;

describe("recordsCount", () => {
  it("counts in words, with thousands separated", () => {
    expect(recordsCount(0)).toBe("0 records");
    expect(recordsCount(1)).toBe("1 record");
    expect(recordsCount(12)).toBe("12 records");
    expect(recordsCount(1200)).toBe("1,200 records");
  });
});

describe("the collection header", () => {
  it("names the collection as the one h1, with its color mark and its record count", async () => {
    renderHeader("viewer", { listed: 12 });
    const h1 = screen.getByRole("heading", { level: 1, name: "Tasks" });
    expect(h1.querySelector(".ob-mark-28")).not.toBeNull();
    expect(await screen.findByText("12 records")).toBeInTheDocument();
  });

  it("shows the folder's name with a small mark above the title of a collection inside one", () => {
    renderHeader("viewer");
    const folder = within(header()).getByText("Project tracker");
    expect(folder.previousElementSibling).toHaveClass("ob-mark-8");
    expect(folder.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no folder above a top-level collection", () => {
    renderHeader("viewer", { schema: makeSchema("viewer", { is_top_level: true }) });
    expect(within(header()).queryByText("Project tracker")).not.toBeInTheDocument();
  });

  it("follows the count the sidebar keeps, and falls back to the schema's before it has loaded", async () => {
    renderHeader("viewer", { listed: 1_200, table: { record_count: 3 } });
    expect(await screen.findByText("1,200 records")).toBeInTheDocument();
  });

  it("says 1 record for one", async () => {
    renderHeader("viewer", { listed: 1 });
    expect(await screen.findByText("1 record")).toBeInTheDocument();
  });

  it("shows the description as a muted line, which a viewer cannot edit", () => {
    renderHeader("viewer", { table: { description: "Everything the team has to do" } });
    expect(screen.getByText("Everything the team has to do").tagName).toBe("P");
    expect(screen.queryByRole("button", { name: /Everything the team/ })).not.toBeInTheDocument();
  });

  it("shows no description line, and no prompt for one, when there is none", () => {
    renderHeader("creator");
    expect(screen.queryByTitle("Edit description")).not.toBeInTheDocument();
  });

  describe("as a viewer or commenter", () => {
    it.each(["viewer", "commenter"])("has no Share, no New button and no settings (%s)", (role) => {
      renderHeader(role);
      expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^New / })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Collection settings" })).not.toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    });
  });

  describe("as an editor", () => {
    it("has New record, which runs the open layout's way of adding, but no Share and no settings", async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();
      renderHeader("editor", { onAdd });
      expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Collection settings" })).not.toBeInTheDocument();
      const add = screen.getByRole("button", { name: "New record" });
      expect(add).toHaveClass("bg-primary");
      await user.click(add);
      expect(onAdd).toHaveBeenCalledTimes(1);
    });

    it("cannot edit the description", () => {
      renderHeader("editor", { table: { description: "Line" } });
      expect(screen.queryByTitle("Edit description")).not.toBeInTheDocument();
    });

    it("has a New button that waits until the layout can add (a form has no way to)", () => {
      renderHeader("editor");
      expect(screen.getByRole("button", { name: "New record" })).toBeDisabled();
    });
  });

  describe("as a creator", () => {
    it("has Share (secondary), the collection's record name on the primary New button, and the settings", async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();
      const { onShare, onSettings, table } = renderHeader("creator", { table: { record_noun: "client" }, onAdd });
      const share = screen.getByRole("button", { name: "Share" });
      expect(share).not.toHaveClass("bg-primary");
      await user.click(share);
      expect(onShare).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "New client" })).toHaveClass("bg-primary");
      expect(screen.queryByRole("button", { name: "New record" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Collection settings" }));
      expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ id: table.id }));
    });

    it("says New record when the collection has no record name", () => {
      renderHeader("owner");
      expect(screen.getByRole("button", { name: "New record" })).toBeInTheDocument();
    });

    it("edits the description in place: Enter saves it, Escape leaves it", async () => {
      const user = userEvent.setup();
      const { api } = renderHeader("creator", { table: { description: "Old line" }, routes: { "PATCH /api/tables/tbl1": { id: "tbl1" } } });
      await user.click(screen.getByRole("button", { name: "Old line" }));
      let field = screen.getByRole("textbox", { name: "Description" });
      expect(field).toHaveFocus();
      await user.clear(field);
      await user.type(field, "Brand new{Escape}");
      expect(screen.queryByRole("textbox", { name: "Description" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Old line" })).toBeInTheDocument();
      expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "Old line" }));
      field = screen.getByRole("textbox", { name: "Description" });
      await user.clear(field);
      await user.type(field, "Brand new{Enter}");
      await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/tables/tbl1")[0]?.body).toEqual({ description: "Brand new" });
    });

    it("saves nothing when the description was not changed", async () => {
      const user = userEvent.setup();
      const { api } = renderHeader("creator", { table: { description: "Same" } });
      await user.click(screen.getByRole("button", { name: "Same" }));
      fireEvent.blur(screen.getByRole("textbox", { name: "Description" }));
      expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(0);
    });
  });

  it("names the folder, not a collection, when there is none open, with no count and no New button", () => {
    renderHeader("creator", { section: "automations" });
    expect(screen.getByRole("heading", { level: 1, name: "Automations" })).toBeInTheDocument();
    expect(screen.queryByText(/records?$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^New / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });
});

describe("the collection header on a phone", () => {
  it("has the back link, Share, + and search in the 56 px header, and the title under it with the room of the whole row", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const { table } = renderHeader("creator", { phone: true, table: { name: "Archive 2025", record_noun: "client" }, onAdd });
    const bar = header();
    expect(within(bar).getByRole("link", { name: "Back to Collections" })).toHaveAttribute("href", "/workspace/wsp1/collections");
    expect(within(bar).getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    // The title is not squeezed between the buttons: it is not in the bar at all.
    const h1 = screen.getByRole("heading", { level: 1, name: "Archive 2025" });
    expect(bar).not.toContainElement(h1);
    expect(h1.querySelector(".ob-mark-24")).not.toBeNull();
    // The + is the New button, named like it, and reaches the layout.
    await user.click(within(bar).getByRole("button", { name: "New client" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(within(bar).queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(table.name).toBe("Archive 2025");
  });

  it("keeps the settings beside the title, for creators", () => {
    renderHeader("creator", { phone: true });
    expect(screen.getByRole("button", { name: "Collection settings" })).toBeInTheDocument();
  });

  it("has only the back link and search for a viewer", () => {
    renderHeader("viewer", { phone: true });
    const bar = header();
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Search everything"]);
  });
});
