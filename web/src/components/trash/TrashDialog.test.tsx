import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, makeSchema, mockApi, renderWithProviders } from "@/test/utils";
import { TrashButton, TrashDialog } from "./TrashDialog";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const DAY = 24 * 3600_000;
const LISTING = {
  items: [
    { kind: "record", id: "rec1", name: "Write the plan", table_id: "tbl1", deleted_at: NOW - 2 * DAY },
    { kind: "table", id: "tbl9", name: "Old budget", table_id: null, deleted_at: NOW - 5 * DAY },
    { kind: "field", id: "fld9", name: "Legacy", table_id: "tbl1", deleted_at: NOW - 3600_000 },
    { kind: "view", id: "viw9", name: "", table_id: "tbl2", deleted_at: NOW - 10 * 60_000 },
  ],
};

describe("TrashDialog", () => {
  it("lists deleted items grouped by kind with relative times, places and the retention note", async () => {
    mockApi({ "GET /api/bases/app1/trash": LISTING });
    renderWithProviders(<TrashDialog open onOpenChange={() => {}} schema={makeSchema("creator")} />);
    const dialog = await screen.findByRole("dialog", { name: "Trash" });
    expect(within(dialog).getByText(/30 days by default/)).toBeInTheDocument();
    const headings = (await within(dialog).findAllByRole("heading", { level: 3 })).map((h) => h.textContent?.replace(/\s+/g, " ").trim());
    expect(headings).toEqual(["Tables (1)", "Fields (1)", "Views (1)", "Records (1)"]);
    expect(within(dialog).getByText("Old budget")).toBeInTheDocument();
    expect(within(dialog).getByText("Deleted 2 days ago in Tasks")).toBeInTheDocument();
    expect(within(dialog).getByText("Deleted 5 days ago")).toBeInTheDocument();
    expect(within(dialog).getByText("Unnamed view")).toBeInTheDocument();
    expect(within(dialog).getByText("Deleted 10 minutes ago in People")).toBeInTheDocument();
  });

  it("restores an item, then reloads the trash and the base", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockApi({
      "GET /api/bases/app1/trash": () => (calls++ === 0 ? LISTING : { items: LISTING.items.filter((i) => i.id !== "rec1") }),
      "POST /api/trash/restore": { ok: true, restored_field_ids: [] },
      "GET /api/bases/app1": makeSchema("creator"),
    });
    renderWithProviders(<TrashDialog open onOpenChange={() => {}} schema={makeSchema("creator")} />);
    await user.click(await screen.findByRole("button", { name: "Restore Write the plan" }));
    await waitFor(() => expect(api.callsTo("POST /api/trash/restore")).toHaveLength(1));
    expect(api.callsTo("POST /api/trash/restore")[0]!.body).toEqual({ kind: "record", id: "rec1" });
    await waitFor(() => expect(screen.queryByText("Write the plan")).not.toBeInTheDocument());
    expect(await screen.findByText("Restored Write the plan")).toBeInTheDocument();
  });

  it("shows an empty state and an error with retry", async () => {
    mockApi({ "GET /api/bases/app1/trash": { items: [] } });
    const { unmount } = renderWithProviders(<TrashDialog open onOpenChange={() => {}} schema={makeSchema("creator")} />);
    expect(await screen.findByText("The trash is empty.")).toBeInTheDocument();
    unmount();

    mockApi({ "GET /api/bases/app1/trash": apiError(403, "forbidden", "Only creators can see the trash") });
    renderWithProviders(<TrashDialog open onOpenChange={() => {}} schema={makeSchema("creator")} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Only creators can see the trash");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("reports a failed restore without removing the item", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/bases/app1/trash": LISTING, "POST /api/trash/restore": apiError(409, "conflict", "A table with that name exists") });
    renderWithProviders(<TrashDialog open onOpenChange={() => {}} schema={makeSchema("creator")} />);
    await user.click(await screen.findByRole("button", { name: "Restore Old budget" }));
    expect(await screen.findByText("Could not restore Old budget")).toBeInTheDocument();
    expect(screen.getByText("Old budget")).toBeInTheDocument();
  });
});

describe("TrashButton", () => {
  it("is available to creators and owners only", async () => {
    mockApi({ "GET /api/bases/app1/trash": { items: [] } });
    const user = userEvent.setup();
    const editor = renderWithProviders(<TrashButton schema={makeSchema("editor")} />);
    expect(screen.queryByRole("button", { name: "Trash" })).not.toBeInTheDocument();
    editor.unmount();
    renderWithProviders(<TrashButton schema={makeSchema("creator")} />);
    await user.click(screen.getByRole("button", { name: "Trash" }));
    expect(await screen.findByRole("dialog", { name: "Trash" })).toBeInTheDocument();
  });
});
