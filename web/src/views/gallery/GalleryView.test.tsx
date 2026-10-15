import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import GalleryView from "./GalleryView";
import { GALLERY_PAGE } from "./useGalleryData";

afterEach(() => vi.unstubAllGlobals());

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

  it("names the cover field in the toolbar, tinted, and crops from the More menu", async () => {
    const user = userEvent.setup();
    const view = gallery();
    const { api } = setup("editor", view, records, { "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) });
    await screen.findByRole("button", { name: "R1" });
    expect(screen.getAllByRole("button", { name: "Cover: Cover" })[0]!.className).toContain("bg-primary-soft");
    await user.click(screen.getByRole("button", { name: /^(More|Tools)/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Crop cover images" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { gallery: { cover_crop: boolean } } }).config.gallery.cover_crop).toBe(true);
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
    expect(asked.map((a) => [a.offset, a.limit])).toEqual([
      [0, GALLERY_PAGE],
      [GALLERY_PAGE, GALLERY_PAGE],
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
