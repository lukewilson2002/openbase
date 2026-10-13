/**
 * Canvas drawing helpers for the custom cell renderer. Pure functions of a 2D context; no
 * React and no library types beyond the plain rectangle and theme shape, so they are easy to
 * keep when the grid library changes.
 */
import { paletteColor, mixColors } from "@/lib/cells/palette";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawTheme {
  baseFontFull: string;
  textDark: string;
  textMedium: string;
  textLight: string;
  linkColor: string;
  accentColor: string;
  bgCell: string;
  cellHorizontalPadding: number;
  cellVerticalPadding: number;
  lineHeight: number;
  borderColor: string;
}

export const DANGER = "#c4261d";

/** Truncate `text` with an ellipsis so it fits `maxWidth` (binary search on measured width). */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${text.slice(0, lo)}…`;
}

/** Split text into at most `maxLines` lines that fit `maxWidth`; the last line is ellipsised. */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  outer: for (const para of paragraphs) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const candidate = line + w;
      if (line !== "" && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line.trimEnd());
        line = w.trimStart();
        if (lines.length >= maxLines) break outer;
      } else line = candidate;
    }
    lines.push(line.trimEnd());
    if (lines.length >= maxLines) break;
  }
  if (lines.length > maxLines) lines.length = maxLines;
  // Ellipsise a truncated last line (or any line wider than the cell, e.g. one long word).
  return lines.map((l, i) => (i === lines.length - 1 || ctx.measureText(l).width > maxWidth ? fitText(ctx, l, maxWidth) : l));
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export interface TextOptions {
  color: string;
  align?: "left" | "right";
  /** Highlighted substring (case-insensitive), drawn on a marker background. */
  highlight?: string;
  highlightColor?: string;
  underline?: boolean;
  bold?: boolean;
}

/** Draw single- or multi-line text inside a cell, vertically centred when it is one line. */
export function drawCellText(ctx: CanvasRenderingContext2D, theme: DrawTheme, rect: Rect, text: string, opts: TextOptions): void {
  if (!text) return;
  const padX = theme.cellHorizontalPadding;
  const maxWidth = rect.width - padX * 2;
  const lineHeight = Math.round(parseFloat(/(\d+(?:\.\d+)?)px/.exec(theme.baseFontFull)?.[1] ?? "13") * 1.4);
  const maxLines = Math.max(1, Math.floor((rect.height - 8) / lineHeight));
  ctx.font = opts.bold ? theme.baseFontFull.replace(/^(?:\d+\s+)?/, "600 ") : theme.baseFontFull;
  ctx.fillStyle = opts.color;
  ctx.textBaseline = "middle";
  const lines = maxLines > 1 ? wrapLines(ctx, text, maxWidth, maxLines) : [fitText(ctx, text.replace(/\s*\n\s*/g, " "), maxWidth)];
  const blockHeight = lines.length * lineHeight;
  let y = maxLines > 1 ? rect.y + 5 + lineHeight / 2 : rect.y + rect.height / 2;
  if (maxLines > 1 && lines.length === 1) y = rect.y + rect.height / 2;
  else if (maxLines > 1) y = rect.y + Math.max(4, (rect.height - blockHeight) / 2) + lineHeight / 2;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    const x = opts.align === "right" ? rect.x + rect.width - padX - w : rect.x + padX;
    if (opts.highlight) {
      const i = line.toLowerCase().indexOf(opts.highlight.toLowerCase());
      if (i >= 0) {
        const before = ctx.measureText(line.slice(0, i)).width;
        const hit = ctx.measureText(line.slice(i, i + opts.highlight.length)).width;
        ctx.fillStyle = opts.highlightColor ?? "#fff3a3";
        ctx.fillRect(x + before - 1, y - lineHeight / 2 + 2, hit + 2, lineHeight - 4);
        ctx.fillStyle = opts.color;
      }
    }
    ctx.fillText(line, x, y);
    if (opts.underline) {
      ctx.fillRect(x, y + lineHeight / 2 - 3, w, 1);
    }
    y += lineHeight;
  }
}

export interface ChipDraw {
  text: string;
  color?: string;
  kind: "select" | "link" | "user" | "plain";
}

/** Flow chips left to right, wrapping into further lines when the row is tall enough. Returns the x extents drawn per chip. */
export function drawChips(ctx: CanvasRenderingContext2D, theme: DrawTheme, rect: Rect, chips: readonly ChipDraw[], dark: boolean, highlight?: string): { x: number; y: number; w: number; h: number }[] {
  const padX = theme.cellHorizontalPadding;
  const chipH = 20;
  const gap = 4;
  const lines = Math.max(1, Math.floor((rect.height - 6) / (chipH + gap)));
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  ctx.font = theme.baseFontFull.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${Math.max(11, Number(n) - 1)}px`);
  ctx.textBaseline = "middle";
  const startY = lines === 1 ? rect.y + (rect.height - chipH) / 2 : rect.y + 5;
  let x = rect.x + padX;
  let line = 0;
  const right = rect.x + rect.width - padX;
  for (const chip of chips) {
    const avatar = chip.kind === "user" ? 16 : 0;
    const textW = ctx.measureText(chip.text).width;
    let w = Math.min(textW + 12 + (avatar ? avatar + 2 : 0), right - rect.x - padX);
    if (x + w > right && x > rect.x + padX) {
      line++;
      x = rect.x + padX;
      if (line >= lines) break;
    }
    if (x >= right) break;
    w = Math.min(w, right - x);
    const y = startY + line * (chipH + gap);
    const pal = chip.kind === "select" ? paletteColor(chip.color) : chip.kind === "link" ? paletteColor("blue") : paletteColor("gray");
    const bg = dark && chip.kind !== "select" ? mixColors("#1a1e26", pal.bg, 0.55) : pal.bg;
    const fg = dark && chip.kind !== "select" ? "#e8ebf1" : pal.fg;
    ctx.fillStyle = bg;
    roundRectPath(ctx, x, y, w, chipH, chip.kind === "link" ? 4 : chipH / 2);
    ctx.fill();
    let tx = x + 6;
    if (avatar) {
      ctx.fillStyle = mixColors(bg, fg, 0.25);
      ctx.beginPath();
      ctx.arc(x + 2 + avatar / 2, y + chipH / 2, avatar / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.font = ctx.font.replace(/\d+(?:\.\d+)?px/, "9px");
      const initials = chip.text.split(/\s+/).map((p) => p[0] ?? "").join("").slice(0, 2).toUpperCase();
      ctx.textAlign = "center";
      ctx.fillText(initials, x + 2 + avatar / 2, y + chipH / 2 + 0.5);
      ctx.textAlign = "left";
      ctx.font = theme.baseFontFull.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${Math.max(11, Number(n) - 1)}px`);
      tx = x + avatar + 6;
    }
    ctx.fillStyle = fg;
    const label = fitText(ctx, chip.text, x + w - tx - 5);
    if (highlight) {
      const i = label.toLowerCase().indexOf(highlight.toLowerCase());
      if (i >= 0) {
        const before = ctx.measureText(label.slice(0, i)).width;
        const hit = ctx.measureText(label.slice(i, i + highlight.length)).width;
        ctx.fillStyle = "#fff3a3";
        ctx.fillRect(tx + before - 1, y + 3, hit + 2, chipH - 6);
        ctx.fillStyle = fg;
      }
    }
    ctx.fillText(label, tx, y + chipH / 2 + 0.5);
    boxes.push({ x, y, w, h: chipH });
    x += w + gap;
  }
  return boxes;
}

/** A filled or outlined five-point star (or the given icon) centred at (cx, cy). */
export function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, filled: boolean): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function drawHeart(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, filled: boolean): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.85);
  ctx.bezierCurveTo(cx - r * 1.4, cy - r * 0.1, cx - r * 0.7, cy - r * 1.1, cx, cy - r * 0.35);
  ctx.bezierCurveTo(cx + r * 0.7, cy - r * 1.1, cx + r * 1.4, cy - r * 0.1, cx, cy + r * 0.85);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function drawCheck(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - size / 2, cy);
  ctx.lineTo(cx - size / 8, cy + size / 2.8);
  ctx.lineTo(cx + size / 2, cy - size / 2.8);
  ctx.stroke();
}

/** Small "expand" glyph (two diagonal arrows) in a rounded square. */
export function drawExpandIcon(ctx: CanvasRenderingContext2D, rect: Rect, color: string, bg: string): void {
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 4);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineCap = "round";
  const { x, y, width: w, height: h } = rect;
  const p = 4;
  const a = 4;
  ctx.beginPath();
  ctx.moveTo(x + p + a, y + p);
  ctx.lineTo(x + p, y + p);
  ctx.lineTo(x + p, y + p + a);
  ctx.moveTo(x + p, y + p);
  ctx.lineTo(x + p + 3, y + p + 3);
  ctx.moveTo(x + w - p - a, y + h - p);
  ctx.lineTo(x + w - p, y + h - p);
  ctx.lineTo(x + w - p, y + h - p - a);
  ctx.moveTo(x + w - p, y + h - p);
  ctx.lineTo(x + w - p - 3, y + h - p - 3);
  ctx.stroke();
}

export function drawChevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, open: boolean, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (open) {
    ctx.moveTo(cx - 3.5, cy - 1.5);
    ctx.lineTo(cx, cy + 2);
    ctx.lineTo(cx + 3.5, cy - 1.5);
  } else {
    ctx.moveTo(cx - 1.5, cy - 3.5);
    ctx.lineTo(cx + 2, cy);
    ctx.lineTo(cx - 1.5, cy + 3.5);
  }
  ctx.stroke();
}

/** Extension label for a non-image attachment. */
export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1, i + 5).toUpperCase() : "FILE";
}
