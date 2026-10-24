import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
import { ALL_FIELDS } from "@/test/fields";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import GalleryView from "./GalleryView";
import { GALLERY_PAGE } from "./useGalleryData";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const gallery = (patch: Record<string, unknown> = {}) => viewWithConfig("viw1", "gallery", { gallery: { cover_field_id: F.cover.id, cover_crop: false, ...patch } });

const cover = [{ id: "att1", filename: "a.png", mime: "image/png", size: 1 }];
const records = [rec("r1", { [F.cover.id]: cover, [F.effort.id]: 2 }), rec("r2", { [F.status.id]: "s2" })];

function setup(role = "editor", view = gallery(), recs = records, routes: Record<string, unknown> = {}) {
  const asked: QueryRequest[] = [];
  return { asked, ...renderView(GalleryView, { schema: projectSchema(role, [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records: recs, colors: { r2: "green" } }, asked), ...routes } as never }) };
}

describe("GalleryView", () => {
  it("shows a card per record with title, fields, row colour and the cover image", async () => {
    setup();
    const card = await screen.findByRole("button", { name: "R1" });
    const img = card.querySelector("img")!;
    expect(img).toHaveAttribute("src", "/api/attachments/att1/thumb");
    expect(img.className).toContain("object-contain"); // fit
    expect(within(card).getByText("2.00")).toBeInTheDocument();
    expect(document.querySelector("[data-record-id='r2'] [data-row-color='green']")).not.toBeNull();
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });

  it("draws a cover only on cards whose record has a picture", async () => {
    setup();
    await screen.findByRole("button", { name: "R1" });
    expect(screen.getByRole("button", { name: "R2" }).querySelector("img")).toBeNull();
  });

  it("keeps the cover and its fit together behind the toolbar's View button", async () => {
    const user = userEvent.setup();
    const view = gallery();
    const { api } = setup("editor", view, records, { "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) });
    await screen.findByRole("button", { name: "R1" });
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);
    expect(await screen.findByRole("combobox", { name: "Cover image" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Crop cover images" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { gallery: { cover_crop: boolean } } }).config.gallery.cover_crop).toBe(true);
  });

  it("says why the crop setting is off when the view has no cover", async () => {
    const user = userEvent.setup();
    setup("editor", gallery({ cover_field_id: null }));
    await screen.findByRole("button", { name: "R1" });
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);
    expect(await screen.findByRole("checkbox", { name: "Crop cover images" })).toBeDisabled();
    expect(screen.getByText("Choose a cover image above to set how pictures fit.")).toBeInTheDocument();
  });

  it("crops covers when the view says so", async () => {
    setup("editor", gallery({ cover_crop: true }));
    const card = await screen.findByRole("button", { name: "R1" });
    expect(card.querySelector("img")!.className).toContain("object-cover");
  });

  it("pages through the view as you ask for more", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: GALLERY_PAGE + 10 }, (_, i) => rec(`m${i}`, {}));
    const { asked } = setup("editor", gallery(), many);
    await screen.findByRole("button", { name: "M0" });
    expect(screen.getAllByRole("button", { name: /^M\d+$/ })).toHaveLength(GALLERY_PAGE);
    expect(screen.getByText(`${GALLERY_PAGE} of ${GALLERY_PAGE + 10} items`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^M\d+$/ })).toHaveLength(GALLERY_PAGE + 10));
    // Each ask loads the cards already shown and one page more, so the writes see them all in one list.
    expect(asked.map((a) => [a.offset, a.limit])).toEqual([
      [0, GALLERY_PAGE],
      [0, GALLERY_PAGE * 2],
    ]);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("adds a record from the add card and opens it", async () => {
    const user = userEvent.setup();
    const created = rec("r9", {});
    const { api } = setup("editor", gallery(), records, { "POST /api/tables/tbl1/records": { records: [created] }, "GET /api/tables/tbl1/records/r9": created });
    await user.click(await screen.findByRole("button", { name: "Add record" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("?record=r9"));
  });

  it("opens a record from its card, and hides the add card from viewers", async () => {
    const user = userEvent.setup();
    setup("viewer", gallery(), records, { "GET /api/tables/tbl1/records/r2": records[1]! });
    expect(screen.queryByRole("button", { name: "Add record" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "R2" }));
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r2");
  });

  it("says so when there are no records, with an Add for editors only", async () => {
    setup("editor", gallery(), []);
    expect(await screen.findByText("No records yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("offers viewers no Add when there are no records", async () => {
    setup("viewer", gallery(), []);
    expect(await screen.findByText("No records yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });
});

/** Four cards in two columns, so the arrow keys have a grid to move over. */
function layOutInTwoColumns() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const i = Number(/\d+/.exec(this.dataset.recordId ?? "")?.[0] ?? 0);
    const left = (i % 2) * 200;
    const top = Math.floor(i / 2) * 100;
    return { left, top, width: 190, height: 90, right: left + 190, bottom: top + 90, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

const four = [0, 1, 2, 3].map((i) => rec(`r${i}`, {}));

describe("GalleryView keyboard and selection", () => {
  it("makes one card the tab stop and moves between cards with the arrow keys", async () => {
    layOutInTwoColumns();
    const user = userEvent.setup();
    setup("editor", gallery(), four);
    await screen.findByRole("button", { name: "R0" });
    expect(screen.getAllByRole("button", { name: /^R\d$/ }).map((c) => c.tabIndex)).toEqual([0, -1, -1, -1]);
    screen.getByRole("button", { name: "R0" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "R1" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "R3" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowUp}");
    expect(screen.getByRole("button", { name: "R0" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "R3" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "R0" })).toHaveFocus();
    // The card last focused is the tab stop.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "R2" }).tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "R0" }).tabIndex).toBe(-1);
  });

  it("opens a card with Enter and selects it with Space", async () => {
    const user = userEvent.setup();
    setup("editor", gallery(), four, { "GET /api/tables/tbl1/records/r1": four[1]! });
    await screen.findByRole("button", { name: "R1" });
    screen.getByRole("button", { name: "R1" }).focus();
    await user.keyboard(" ");
    expect(screen.getByTestId("where")).not.toHaveTextContent("record=");
    expect(screen.getByRole("button", { name: "R1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("toolbar", { name: "Selected records" })).toHaveTextContent("1 selected");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r1");
  });

  it("follows a link inside a card on Enter instead of opening the record", async () => {
    const user = userEvent.setup();
    const site = ALL_FIELDS.url!;
    const schema = projectSchema("editor", [gallery()]);
    schema.tables[0]!.fields = [...schema.tables[0]!.fields, site];
    const withLink = [rec("r0", { [site.id]: "https://example.com/a" })];
    renderView(GalleryView, { schema, viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records: withLink }) } as never });
    const link = await screen.findByRole("link");
    const click = vi.fn((e: MouseEvent) => e.preventDefault());
    link.addEventListener("click", click);
    link.focus();
    await user.keyboard("{Enter}");
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("where")).not.toHaveTextContent("record=");
    await user.click(link);
    expect(screen.getByTestId("where")).not.toHaveTextContent("record=");
  });

  it("selects with Ctrl-click and Shift-click, with a bar to duplicate or delete the selection", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", gallery(), four, {
      "POST /api/tables/tbl1/records/duplicate": { records: [rec("c1", {}), rec("c2", {})] },
      "DELETE /api/tables/tbl1/records": null,
    });
    await screen.findByRole("button", { name: "R0" });
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("button", { name: "R0" }));
    await user.keyboard("{/Control}");
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "R2" }));
    await user.keyboard("{/Shift}");
    const bar = screen.getByRole("toolbar", { name: "Selected records" });
    expect(bar).toHaveTextContent("3 selected");
    expect(screen.getByRole("checkbox", { name: "Select R1" })).toBeChecked();
    expect(screen.getByTestId("where")).not.toHaveTextContent("record=");
    await user.click(within(bar).getByRole("button", { name: /Duplicate/ }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")[0]!.body).toEqual({ ids: ["r0", "r1", "r2"] }));
    // The copies are made; the selection is let go.
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected records" })).not.toBeInTheDocument());
  });

  it("asks before deleting the selection", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", gallery(), four, { "DELETE /api/tables/tbl1/records": null });
    await screen.findByRole("button", { name: "R0" });
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("button", { name: "R0" }));
    await user.click(screen.getByRole("button", { name: "R3" }));
    await user.keyboard("{/Control}");
    await user.click(within(screen.getByRole("toolbar", { name: "Selected records" })).getByRole("button", { name: /Delete/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Delete 2 records?");
    await user.click(screen.getByRole("button", { name: "Delete 2 records" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r0", "r3"] }));
  });

  it("selects every card with Ctrl+A and clears with Escape", async () => {
    const user = userEvent.setup();
    setup("editor", gallery(), four);
    await screen.findByRole("button", { name: "R0" });
    screen.getByRole("button", { name: "R0" }).focus();
    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByRole("toolbar", { name: "Selected records" })).toHaveTextContent("4 selected");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar", { name: "Selected records" })).not.toBeInTheDocument();
  });

  it("deletes the focused card with the Delete key, with an Undo", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", gallery(), four, { "DELETE /api/tables/tbl1/records": null });
    await screen.findByRole("button", { name: "R2" });
    screen.getByRole("button", { name: "R2" }).focus();
    await user.keyboard("{Delete}");
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r2"] }));
    expect(await screen.findByText("Record deleted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("does not delete for viewers", async () => {
    const user = userEvent.setup();
    const { api } = setup("viewer", gallery(), four, { "DELETE /api/tables/tbl1/records": null });
    await screen.findByRole("button", { name: "R2" });
    screen.getByRole("button", { name: "R2" }).focus();
    await user.keyboard("{Delete}");
    expect(api.callsTo("DELETE /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("opens a menu on right-click with open, select, duplicate and delete", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", gallery(), four, { "POST /api/tables/tbl1/records/duplicate": { records: [rec("c1", {})] } });
    await screen.findByRole("button", { name: "R1" });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "R1" }) });
    const menu = await screen.findByRole("menu", { name: "Record menu" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Open record", "Select", "Duplicate record", "Move to start", "Delete record"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Duplicate record" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")[0]!.body).toEqual({ ids: ["r1"] }));
  });

  it("offers viewers the menu without duplicate or delete", async () => {
    const user = userEvent.setup();
    setup("viewer", gallery(), four);
    await screen.findByRole("button", { name: "R1" });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "R1" }) });
    const menu = await screen.findByRole("menu", { name: "Record menu" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Open record", "Select"]);
  });
});

describe("GalleryView order", () => {
  it("moves a card with Alt+Arrow through the move endpoint", async () => {
    layOutInTwoColumns();
    const user = userEvent.setup();
    // A server that keeps the order it is given.
    let order = four;
    const { api } = setup("editor", gallery(), four, {
      "POST /api/views/viw1/query": () => ({ total: order.length, offset: 0, records: order, groups: [], colors: {} }),
      "POST /api/tables/tbl1/records/move": () => {
        order = [order[1]!, order[0]!, order[2]!, order[3]!];
        return { records: [] };
      },
    });
    await screen.findByRole("button", { name: "R0" });
    screen.getByRole("button", { name: "R0" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records/move")[0]!.body).toEqual({ ids: ["r0"], before_id: null, after_id: "r1" });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^R\d$/ }).map((c) => c.getAttribute("aria-label"))).toEqual(["R1", "R0", "R2", "R3"]));
    expect(await screen.findByText("Record moved")).toBeInTheDocument();
    // Focus stays on the card that moved.
    expect(screen.getByRole("button", { name: "R0" })).toHaveFocus();
  });

  it("moves a card to the start from its menu", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", gallery(), four, { "POST /api/tables/tbl1/records/move": { records: [] } });
    await screen.findByRole("button", { name: "R2" });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "R2" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Move to start" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/move")[0]!.body).toEqual({ ids: ["r2"], before_id: "r0", after_id: null }));
  });

  it("keeps the order when the view sorts", async () => {
    layOutInTwoColumns();
    const user = userEvent.setup();
    const sorted = viewWithConfig("viw1", "gallery", { sorts: [{ field_id: F.name.id, direction: "asc" }], gallery: { cover_field_id: F.cover.id, cover_crop: false } });
    const { api } = setup("editor", sorted, four, { "POST /api/tables/tbl1/records/move": { records: [] } });
    await screen.findByRole("button", { name: "R0" });
    screen.getByRole("button", { name: "R0" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "R2" }) });
    expect(screen.queryByRole("menuitem", { name: "Move to start" })).not.toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(0);
  });
});

describe("GalleryView fields", () => {
  it("says how many fields a card leaves out", async () => {
    const extra = ["f_n1", "f_n2", "f_n3", "f_n4", "f_n5", "f_n6", "f_n7"].map((id) => ({ ...ALL_FIELDS.number!, id, name: id }));
    const schema = projectSchema("editor", [gallery()]);
    schema.tables[0]!.fields = [F.name, F.cover, ...extra];
    const values = Object.fromEntries(extra.slice(0, 6).map((f, i) => [f.id, i + 1]));
    renderView(GalleryView, { schema, viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records: [rec("r0", values), rec("r1", { f_n1: 1 })] }) } as never });
    const card = await screen.findByRole("button", { name: "R0" });
    expect(within(card).getByText("+1 more field")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "R1" }).querySelector("[data-more-fields]")).toBeNull();
  });
});

describe("GalleryView record panel", () => {
  it("loads the next page when Next nears the end of what is loaded", async () => {
    const many = Array.from({ length: GALLERY_PAGE + 10 }, (_, i) => rec(`m${i}`, {}));
    const { asked } = setup("editor", gallery(), many, { [`GET /api/tables/tbl1/records/m${GALLERY_PAGE - 1}`]: many[GALLERY_PAGE - 1]! });
    await screen.findByRole("button", { name: "M0" });
    expect(asked).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: `M${GALLERY_PAGE - 1}` }));
    await waitFor(() => expect(asked.map((a) => a.limit)).toEqual([GALLERY_PAGE, GALLERY_PAGE * 2]));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /Next record/ })).toBeEnabled());
  });

  it("keeps Previous and Next for a record that no longer matches the view", async () => {
    const user = userEvent.setup();
    let served = four;
    const { client } = setup("editor", gallery(), four, { "POST /api/views/viw1/query": () => ({ total: served.length, offset: 0, records: served, groups: [], colors: {} }), "GET /api/tables/tbl1/records/r1": four[1]! });
    await user.click(await screen.findByRole("button", { name: "R1" }));
    const dialog = await screen.findByRole("dialog");
    served = [four[0]!, four[2]!, four[3]!];
    await client.invalidateQueries({ queryKey: ["records"] });
    await waitFor(() => expect(screen.queryByRole("button", { name: "R1" })).not.toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: /Previous record/ })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: /Next record/ })).toBeEnabled();
  });
});

