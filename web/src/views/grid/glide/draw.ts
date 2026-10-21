/**
 * Canvas drawing helpers for the custom cell renderer. Pure functions of a 2D context; no
 * React and no library types beyond the plain rectangle and theme shape, so they are easy to
 * keep when the grid library changes.
 */
import { paletteColor, mixColors } from "@/lib/cells/palette";
import { accentShade } from "@/lib/colors";

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
/**
 * The font of a chip: the cell's a pixel smaller; a linked record's title is medium weight, as on its
 * card elsewhere (see RecordSummary).
 */
export function chipFont(baseFontFull: string, kind: ChipDraw["kind"]): string {
  const smaller = baseFontFull.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${Math.max(11, Number(n) - 1)}px`);
  return kind === "link" ? `500 ${smaller.replace(/^\s*(?:normal|bold|bolder|lighter|[1-9]00)\s+/, "")}` : smaller;
}

/** Room around a chip's text (and a person's face): the horizontal padding `drawChips` gives it. */
export function chipPadding(kind: ChipDraw["kind"]): number {
  return kind === "link" ? 14 : kind === "user" ? 12 + 18 : 12;
}

/** Where `drawChips` puts each chip that fits in `rect` (the first ones, in order: `index` into the chips). */
export interface PlacedChip {
  index: number;
  chip: ChipDraw;
  x: number;
  y: number;
  w: number;
  h: number;
  avatar: number;
}

/**
 * Lays chips out in a cell: left to right, onto more lines in a taller row, the lines filled centred
 * in it. Shared by drawing and by finding the chip under the pointer (a linked record's preview).
 */
export interface ChipLayout {
  placed: PlacedChip[];
  /** The chips that did not fit, counted at the end of the last line ("+3"). */
  more: { count: number; x: number; y: number; w: number; h: number } | null;
}

export function layoutChips(ctx: CanvasRenderingContext2D, theme: Pick<DrawTheme, "baseFontFull" | "cellHorizontalPadding">, rect: Rect, chips: readonly ChipDraw[]): ChipLayout {
  const padX = theme.cellHorizontalPadding;
  const lines = Math.max(1, Math.floor((rect.height - 6) / (CHIP_H + CHIP_GAP)));
  // Lay the chips out first, then centre the lines they fill: in a tall row one line of chips sits in
  // the middle, level with a line of text in the next cell, rather than at the top.
  const placed: { index: number; chip: ChipDraw; x: number; line: number; w: number; avatar: number }[] = [];
  let x = rect.x + padX;
  let line = 0;
  const right = rect.x + rect.width - padX;
  for (const [index, chip] of chips.entries()) {
    const avatar = chip.kind === "user" ? 16 : 0;
    ctx.font = chipFont(theme.baseFontFull, chip.kind);
    const textW = ctx.measureText(chip.text).width;
    let w = Math.min(textW + chipPadding(chip.kind), right - rect.x - padX);
    if (x + w > right && x > rect.x + padX) {
      line++;
      x = rect.x + padX;
      if (line >= lines) break;
    }
    if (x >= right) break;
    w = Math.min(w, right - x);
    placed.push({ index, chip, x, line, w, avatar });
    x += w + CHIP_GAP;
  }
  // Those that do not fit are counted at the end of the last line: the last chips give way to the
  // count (or are shortened, while they keep a readable width) until it fits.
  let more: { count: number; x: number; line: number; w: number } | null = null;
  if (placed.length < chips.length) {
    ctx.font = chipFont(theme.baseFontFull, "plain");
    const widthOf = (n: number) => ctx.measureText(`+${n}`).width + 2;
    let count = chips.length - placed.length;
    for (;;) {
      const last = placed[placed.length - 1];
      const w = widthOf(count);
      const start = last ? last.x + last.w + CHIP_GAP : rect.x + padX;
      if (!last || start + w <= right) {
        more = { count, x: start, line: last?.line ?? 0, w: Math.min(w, right - start) };
        break;
      }
      const room = right - CHIP_GAP - w - last.x;
      if (room >= 48) {
        last.w = room;
        more = { count, x: last.x + room + CHIP_GAP, line: last.line, w };
        break;
      }
      placed.pop();
      count++;
    }
  }
  const used = placed.length > 0 ? placed[placed.length - 1]!.line + 1 : 1;
  const blockH = used * CHIP_H + (used - 1) * CHIP_GAP;
  const startY = rect.y + Math.max(lines > 1 ? 5 : 0, (rect.height - blockH) / 2);
  const yOf = (l: number) => startY + l * (CHIP_H + CHIP_GAP);
  return {
    placed: placed.map(({ line: l, ...p }) => ({ ...p, y: yOf(l), h: CHIP_H })),
    more: more && { count: more.count, x: more.x, y: yOf(more.line), w: more.w, h: CHIP_H },
  };
}

const CHIP_H = 20;
const CHIP_GAP = 4;

export function drawChips(ctx: CanvasRenderingContext2D, theme: DrawTheme, rect: Rect, chips: readonly ChipDraw[], dark: boolean, highlight?: string): { x: number; y: number; w: number; h: number }[] {
  const chipH = CHIP_H;
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  const { placed, more } = layoutChips(ctx, theme, rect, chips);
  ctx.textBaseline = "middle";
  for (const { chip, x, y, w, avatar } of placed) {
    const font = chipFont(theme.baseFontFull, chip.kind);
    ctx.font = font;
    let fg: string;
    if (chip.kind === "link") {
      // A linked record is a small card, as everywhere else records are listed: the cell's own surface
      // (lifted a touch on a dark page), a hairline border, and its title in the accent's text colour.
      ctx.fillStyle = dark ? mixColors(theme.bgCell, theme.textDark, 0.05) : theme.bgCell;
      roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, chipH - 1, 4);
      ctx.fill();
      ctx.strokeStyle = theme.borderColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      fg = theme.linkColor;
    } else {
      // Choices and people carry their own colour, the same pill in both themes; the rest are grey.
      const own = chip.kind === "select" || chip.kind === "user";
      const pal = own ? paletteColor(chip.color) : paletteColor("gray");
      ctx.fillStyle = dark && !own ? mixColors(theme.bgCell, pal.bg, 0.55) : pal.bg;
      fg = dark && !own ? theme.textDark : pal.fg;
      roundRectPath(ctx, x, y, w, chipH, chipH / 2);
      ctx.fill();
    }
    let tx = x + (chip.kind === "link" ? 7 : 6);
    if (avatar) {
      // Solid face with white initials, the same as <Avatar> outside the grid.
      ctx.fillStyle = accentShade(chip.color);
      ctx.beginPath();
      ctx.arc(x + 2 + avatar / 2, y + chipH / 2, avatar / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = ctx.font.replace(/\d+(?:\.\d+)?px/, "9px");
      const initials = chip.text.split(/\s+/).map((p) => p[0] ?? "").join("").slice(0, 2).toUpperCase();
      ctx.textAlign = "center";
      ctx.fillText(initials, x + 2 + avatar / 2, y + chipH / 2 + 0.5);
      ctx.textAlign = "left";
      ctx.font = font;
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
  }
  if (more) {
    // How many more there are, as plain text (no pill): double-click the cell to see them all.
    ctx.font = chipFont(theme.baseFontFull, "plain");
    ctx.fillStyle = theme.textLight;
    ctx.fillText(`+${more.count}`, more.x + 1, more.y + chipH / 2 + 0.5);
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

