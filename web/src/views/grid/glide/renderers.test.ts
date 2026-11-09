import { describe, expect, it, vi } from "vitest";
import type { DrawArgs } from "@glideapps/glide-data-grid";
import { ALL_FIELDS } from "@/test/fields";
import type { RecordCellModel } from "../adapter";
import { toGridCell, type ObCell } from "./cells";
import { createRenderer, type RendererContext } from "./renderers";

/** A canvas that records what is written and with which font. */
function recorder() {
  const writes: { text: string; font: string }[] = [];
  const ctx = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textBaseline: "",
    textAlign: "",
    globalAlpha: 1,
    lineWidth: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    measureText: (s: string) => ({ width: s.length * 7 }),
    fillText(text: string) {
      writes.push({ text, font: this.font });
    },
  };
  return { ctx, writes };
}

const theme = { baseFontFull: "14px sans-serif", textDark: "#111", textMedium: "#444", textLight: "#777", linkColor: "#00f", accentColor: "#00f", bgCell: "#fff", bgHeader: "#eee", cellHorizontalPadding: 14, cellVerticalPadding: 3, lineHeight: 1.4, borderColor: "#ddd" };
const rc = (over: Partial<RendererContext> = {}): RendererContext => ({ searchTerm: "", dark: false, newLabel: "New client", hoveredRow: () => null, isSelected: () => false, canExpand: true, onExpand: vi.fn(), thumbUrl: (id) => `/api/attachments/${id}/thumb`, onOpenUrl: vi.fn(), ...over });
const drawn = (cell: ObCell, context: RendererContext) => {
  const { ctx, writes } = recorder();
  const renderer = createRenderer(() => context);
  const args = { ctx, rect: { x: 0, y: 0, width: 240, height: 46 }, theme, highlighted: false, hoverAmount: 0, col: 0, row: 0 } as unknown as DrawArgs<ObCell>;
  renderer.draw(args, cell);
  return writes;
};

describe("the grid's custom cells", () => {
  it("ends a group with '+ New <record name>'", () => {
    const add = toGridCell({ kind: "add" }) as ObCell;
    expect(drawn(add, rc()).map((w) => w.text)).toEqual(["+ New client"]);
    expect(drawn(add, rc({ newLabel: "New record" })).map((w) => w.text)).toEqual(["+ New record"]);
  });

  it("sets the title column's text in 600 and the other columns' in the regular weight", () => {
    const model = (isPrimary: boolean): RecordCellModel => ({ kind: "cell", recordId: "r1", field: ALL_FIELDS.text!, value: "Harper", display: "Harper", chips: [], readOnly: false, isPrimary });
    expect(drawn(toGridCell(model(true)) as ObCell, rc())[0]).toEqual({ text: "Harper", font: "600 14px sans-serif" });
    expect(drawn(toGridCell(model(false)) as ObCell, rc())[0]).toEqual({ text: "Harper", font: "14px sans-serif" });
  });

  it("draws a choice's name as a 12 px medium chip and a linked record's name beside its mark", () => {
    const choice: RecordCellModel = { kind: "cell", recordId: "r1", field: ALL_FIELDS.single_select!, value: "chs1", display: "Todo", chips: [{ text: "Todo", color: "gray", id: "chs1" }], readOnly: false, isPrimary: false };
    expect(drawn(toGridCell(choice) as ObCell, rc())[0]).toEqual({ text: "Todo", font: "500 12px sans-serif" });
    const link: RecordCellModel = { kind: "cell", recordId: "r1", field: ALL_FIELDS.link!, value: [], display: "Launch", chips: [{ text: "Launch", color: "teal", id: "r2" }], readOnly: false, isPrimary: false };
    const { ctx } = recorder();
    const fills: string[] = [];
    Object.defineProperty(ctx, "fillStyle", { set: (v: string) => fills.push(v), get: () => "" });
    const args = { ctx, rect: { x: 0, y: 0, width: 240, height: 46 }, theme, highlighted: false, hoverAmount: 0, col: 0, row: 0 } as unknown as DrawArgs<ObCell>;
    createRenderer(() => rc()).draw(args, toGridCell(link) as ObCell);
    // The chip is the page's grey; its mark is the collection's own shade (teal), not the choice pastel.
    expect(fills).toContain("#eee");
    expect(fills).toContain("#00857e");
  });
  it("offers to open a record from its title only where there is a page to open", () => {
    const model: RecordCellModel = { kind: "cell", recordId: "r1", field: ALL_FIELDS.text!, value: "Harper", display: "Harper", chips: [], readOnly: true, isPrimary: true };
    const click = (context: RendererContext) => {
      const preventDefault = vi.fn();
      createRenderer(() => context).onClick!({ cell: toGridCell(model) as ObCell, location: [0, 3], posX: 235, bounds: { x: 0, y: 0, width: 240, height: 46 }, preventDefault } as never);
      return preventDefault;
    };
    const open = rc();
    expect(click(open)).toHaveBeenCalled();
    expect(open.onExpand).toHaveBeenCalledWith(3);
    const shared = rc({ canExpand: false });
    expect(click(shared)).not.toHaveBeenCalled();
    expect(shared.onExpand).not.toHaveBeenCalled();
    // And the icon is not drawn over the end of the cell.
    const iconDrawn = (context: RendererContext) => {
      const { ctx } = recorder();
      const arcs = vi.fn();
      Object.assign(ctx, { arcTo: arcs });
      const args = { ctx, rect: { x: 0, y: 0, width: 240, height: 46 }, theme, highlighted: true, hoverAmount: 1, col: 0, row: 0 } as unknown as DrawArgs<ObCell>;
      createRenderer(() => context).draw(args, toGridCell(model) as ObCell);
      return arcs.mock.calls.length > 0;
    };
    expect(iconDrawn(open)).toBe(true);
    expect(iconDrawn(shared)).toBe(false);
  });
});
