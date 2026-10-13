/**
 * The custom cell renderer: draws every field type on the canvas and handles the in-cell click
 * targets (expand icon, rating stars, open-link icon, button). The handler bag is read lazily so
 * the renderer object itself stays stable across renders.
 */
import { GridCellKind, type CustomRenderer, type DrawArgs } from "@glideapps/glide-data-grid";
import { displayShapeOf } from "@/lib/cells/kinds";
import { attachmentRefs } from "@/lib/cells/kinds";
import { isFormulaError } from "@/lib/cells/format";
import { hrefFor, isSafeLink } from "@/lib/cells/text";
import { attachmentsApi } from "@/api/records";
import type { RecordCellModel } from "../adapter";
import { isObCell, withPending, type ObCell } from "./cells";
import { DANGER, drawCellText, drawChevron, drawChips, drawExpandIcon, drawHeart, drawStar, fileExt, fitText, roundRectPath, type ChipDraw } from "./draw";
import { mixColors, paletteColor, ratingColor } from "@/lib/cells/palette";

export interface RendererContext {
  searchTerm: string;
  dark: boolean;
  /** Whether the cell at this display position is the focused cell. */
  isSelected(col: number, row: number): boolean;
  onExpand(row: number): void;
  onOpenUrl(url: string): void;
}

const EXPAND_SIZE = 20;
const OPEN_SIZE = 18;

function chipsFor(m: RecordCellModel): ChipDraw[] {
  const shape = displayShapeOf(m.field);
  const kind: ChipDraw["kind"] = shape === "select" || shape === "multi_select" ? "select" : shape === "link" ? "link" : shape === "user" ? "user" : "plain";
  return m.chips.map((c) => ({ text: c.text, color: c.color, kind }));
}

/** The URL a url/email/phone/button cell opens, or null. */
export function openTargetOf(m: RecordCellModel): string | null {
  switch (m.field.type) {
    case "url":
    case "email":
    case "phone":
      return typeof m.value === "string" ? hrefFor(m.field.type, m.value) : null;
    case "button":
      return typeof m.value === "string" && isSafeLink(m.value) ? m.value : null;
    default:
      return null;
  }
}

function drawRating(args: DrawArgs<ObCell>, m: RecordCellModel, active: boolean): void {
  const { ctx, rect, theme } = args;
  if (m.field.type !== "rating") return;
  const value = typeof m.value === "number" ? m.value : 0;
  const { max, icon, color } = m.field.options;
  const r = 7;
  const step = 17;
  const cy = rect.y + rect.height / 2;
  const tint = ratingColor(color);
  let hover = -1;
  if (active && args.hoverX !== undefined) hover = Math.min(max, Math.max(1, Math.floor((args.hoverX - theme.cellHorizontalPadding) / step) + 1));
  const shown = hover > 0 ? hover : value;
  for (let i = 0; i < max; i++) {
    const cx = rect.x + theme.cellHorizontalPadding + r + i * step;
    if (cx + r > rect.x + rect.width) break;
    const filled = i < shown;
    if (!filled && !active && i >= value) continue;
    const c = filled ? tint : mixColors("#ffffff", "#808080", 0.45);
    if (icon === "heart") drawHeart(ctx, cx, cy, r, c, filled);
    else drawStar(ctx, cx, cy, r, c, filled);
  }
}

function drawAttachments(args: DrawArgs<ObCell>, m: RecordCellModel): void {
  const { ctx, rect, theme, imageLoader, col, row } = args;
  const files = attachmentRefs(m.value);
  const size = Math.min(40, rect.height - 8);
  const gap = 4;
  let x = rect.x + theme.cellHorizontalPadding;
  let y = rect.y + (rect.height - size) / 2;
  const rows = Math.max(1, Math.floor((rect.height - 4) / (size + gap)));
  let line = 0;
  for (const f of files) {
    if (x + size > rect.x + rect.width - 4) {
      line++;
      if (line >= rows) break;
      x = rect.x + theme.cellHorizontalPadding;
    }
    y = rows === 1 ? rect.y + (rect.height - size) / 2 : rect.y + 4 + line * (size + gap);
    ctx.save();
    roundRectPath(ctx, x, y, size, size, 4);
    ctx.clip();
    const isImage = f.mime.startsWith("image/");
    const img = isImage ? imageLoader.loadOrGetImage(attachmentsApi.thumbUrl(f.id), col, row) : undefined;
    if (img) {
      const iw = "width" in img ? img.width : size;
      const ih = "height" in img ? img.height : size;
      const scale = Math.max(size / iw, size / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = paletteColor("gray").bg;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = paletteColor("gray").fg;
      ctx.font = "600 9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(fileExt(f.filename), x + size / 2, y + size / 2);
      ctx.textAlign = "left";
    }
    ctx.restore();
    x += size + gap;
  }
}

function drawOpenIcon(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, color: string, bg: string): void {
  const s = OPEN_SIZE;
  const x = rect.x + rect.width - s - 6;
  const y = rect.y + (rect.height - s) / 2;
  roundRectPath(ctx, x, y, s, s, 4);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + 6, y + 12);
  ctx.lineTo(x + 12, y + 6);
  ctx.moveTo(x + 7, y + 6);
  ctx.lineTo(x + 12, y + 6);
  ctx.lineTo(x + 12, y + 11);
  ctx.stroke();
}

function drawRecordCell(args: DrawArgs<ObCell>, m: RecordCellModel, rc: RendererContext): void {
  const { ctx, rect, theme } = args;
  const shape = displayShapeOf(m.field);
  const active = args.highlighted || args.hoverAmount > 0.01;
  const hl = rc.searchTerm || undefined;
  const textColor = theme.textDark;
  switch (shape) {
    case "text":
    case "long_text":
    case "date":
      drawCellText(ctx, theme, rect, m.display, { color: isFormulaError(m.value) ? DANGER : textColor, highlight: hl });
      break;
    case "number":
      drawCellText(ctx, theme, rect, m.display, { color: isFormulaError(m.value) ? DANGER : textColor, align: isFormulaError(m.value) ? "left" : "right", highlight: hl });
      break;
    case "url":
    case "email":
    case "phone": {
      const target = openTargetOf(m);
      const narrowed = target && active ? { ...rect, width: rect.width - OPEN_SIZE - 6 } : rect;
      drawCellText(ctx, theme, narrowed, m.display, { color: target ? theme.linkColor : textColor, highlight: hl });
      if (target && active) drawOpenIcon(ctx, rect, theme.textMedium, theme.bgCell);
      break;
    }
    case "select":
    case "multi_select":
    case "link":
    case "user":
      if (isFormulaError(m.value)) drawCellText(ctx, theme, rect, m.display, { color: DANGER });
      else drawChips(ctx, theme, rect, chipsFor(m), rc.dark, hl);
      break;
    case "list":
      if (isFormulaError(m.value)) drawCellText(ctx, theme, rect, m.display, { color: DANGER });
      else drawChips(ctx, theme, rect, chipsFor(m), rc.dark, hl);
      break;
    case "attachment":
      drawAttachments(args, m);
      break;
    case "rating":
      drawRating(args, m, args.highlighted && !m.readOnly);
      break;
    case "button": {
      if (!m.display) break;
      const target = openTargetOf(m);
      ctx.font = theme.baseFontFull;
      const label = fitText(ctx, m.display, rect.width - 24);
      const w = ctx.measureText(label).width + 16;
      const h = 22;
      const x = rect.x + theme.cellHorizontalPadding;
      const y = rect.y + (rect.height - h) / 2;
      roundRectPath(ctx, x, y, w, h, 5);
      ctx.fillStyle = target ? theme.accentColor : mixColors("#ffffff", "#808080", 0.3);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 8, y + h / 2 + 0.5);
      break;
    }
    case "checkbox":
      // Checkboxes are drawn by Glide's boolean cell; computed ones arrive here only for errors.
      drawCellText(ctx, theme, rect, m.display, { color: isFormulaError(m.value) ? DANGER : textColor });
      break;
  }
}

function drawGroup(args: DrawArgs<ObCell>, rc: RendererContext): void {
  const { ctx, rect, theme } = args;
  const data = args.cell.data;
  if (data.ob !== "group") return;
  const m = data.model;
  ctx.fillStyle = rc.dark ? "#232833" : "#eef1f6";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  const indent = m.depth * 14;
  drawChevron(ctx, rect.x + 14 + indent, rect.y + rect.height / 2, !m.collapsed, theme.textMedium);
  ctx.font = theme.baseFontFull.replace(/^(?:\d+\s+)?/, "600 ");
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.textDark;
  const labelX = rect.x + 28 + indent;
  const label = fitText(ctx, m.label, rect.width - 28 - indent - 40);
  ctx.fillText(label, labelX, rect.y + rect.height / 2 + 0.5);
  const w = ctx.measureText(label).width;
  ctx.font = theme.baseFontFull;
  ctx.fillStyle = theme.textLight;
  if (labelX + w + 8 < rect.x + rect.width) ctx.fillText(String(m.count), labelX + w + 8, rect.y + rect.height / 2 + 0.5);
}

function drawSummary(args: DrawArgs<ObCell>, rc: RendererContext): void {
  const { ctx, rect, theme } = args;
  const data = args.cell.data;
  if (data.ob !== "summary") return;
  const m = data.model;
  ctx.fillStyle = rc.dark ? "#1f242d" : "#f6f7f9";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = theme.borderColor;
  ctx.fillRect(rect.x, rect.y, rect.width, 1);
  const small = theme.baseFontFull.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${Math.max(11, Number(n) - 1)}px`);
  ctx.font = small;
  ctx.textBaseline = "middle";
  const y = rect.y + rect.height / 2 + 0.5;
  const hovering = args.hoverAmount > 0.01;
  if (!m.label) {
    if (hovering) {
      ctx.fillStyle = theme.textLight;
      ctx.fillText("Summarize", rect.x + theme.cellHorizontalPadding, y);
    }
    return;
  }
  ctx.fillStyle = theme.textLight;
  ctx.fillText(m.label, rect.x + theme.cellHorizontalPadding, y);
  const lw = ctx.measureText(m.label).width;
  ctx.fillStyle = theme.textDark;
  const text = fitText(ctx, m.text, rect.width - theme.cellHorizontalPadding * 2 - lw - 8);
  ctx.fillText(text, rect.x + rect.width - theme.cellHorizontalPadding - ctx.measureText(text).width, y);
}

export function createRenderer(getContext: () => RendererContext): CustomRenderer<ObCell> {
  return {
    kind: GridCellKind.Custom,
    isMatch: (cell): cell is ObCell => isObCell(cell),
    needsHover: true,
    needsHoverPosition: true,
    draw(args, cell) {
      const rc = getContext();
      const { ctx, rect } = args;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      const data = cell.data;
      if (data.ob === "group") drawGroup(args, rc);
      else if (data.ob === "summary") drawSummary(args, rc);
      else {
        const m = data.model;
        drawRecordCell(args, m, rc);
        if (m.isPrimary) {
          if (m.rowColor) {
            const pal = paletteColor(m.rowColor);
            ctx.fillStyle = mixColors(pal.bg, pal.fg, 0.35);
            ctx.fillRect(rect.x, rect.y, 3, rect.height);
          }
          if (args.highlighted || args.hoverAmount > 0.01) {
            drawExpandIcon(ctx, { x: rect.x + rect.width - EXPAND_SIZE - 4, y: rect.y + (rect.height - EXPAND_SIZE) / 2, width: EXPAND_SIZE, height: EXPAND_SIZE }, args.theme.textMedium, args.theme.bgCell);
          }
        }
      }
      ctx.restore();
    },
    onClick(args) {
      const rc = getContext();
      const data = args.cell.data;
      if (data.ob !== "cell") return undefined;
      const m = data.model;
      const [col, row] = args.location;
      // Expand icon on the primary field.
      if (m.isPrimary && args.posX >= args.bounds.width - EXPAND_SIZE - 8) {
        rc.onExpand(row);
        args.preventDefault();
        return undefined;
      }
      const target = openTargetOf(m);
      const selected = rc.isSelected(col, row);
      if (m.field.type === "button" && target) {
        rc.onOpenUrl(target);
        return undefined;
      }
      if (target && (args.ctrlKey || args.metaKey || (selected && args.posX >= args.bounds.width - OPEN_SIZE - 10))) {
        rc.onOpenUrl(target);
        return undefined;
      }
      if (m.field.type === "rating" && !m.readOnly && selected) {
        const { max } = m.field.options;
        const step = 17;
        const idx = Math.floor((args.posX - 8) / step) + 1;
        if (idx >= 1 && idx <= max) {
          const current = typeof m.value === "number" ? m.value : 0;
          return withPending(args.cell, { json: idx === current ? null : idx });
        }
      }
      return undefined;
    },
  };
}
