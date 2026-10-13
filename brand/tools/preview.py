#!/usr/bin/env python3
"""Contact sheet: reference vs master, all variants, small sizes on white and dark."""
import io, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

import os
B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # brand/
REF = sys.argv[1] if len(sys.argv) > 1 else None  # owner reference image (not stored in the repo)
INK = (11, 18, 32)
SHEET = (243, 244, 246)
FONT = "/Library/Fonts/Inter-Medium.ttf"


def render(svg, w, h=None):
    png = subprocess.check_output(["rsvg-convert", "-w", str(w), "-h", str(h or w), svg])
    return Image.open(io.BytesIO(png)).convert("RGBA")


def render_mono(svg, w, colour):
    txt = open(svg).read().replace("currentColor", colour)
    png = subprocess.check_output(["rsvg-convert", "-w", str(w), "-h", str(w)], input=txt.encode())
    return Image.open(io.BytesIO(png)).convert("RGBA")


def panel(w, h, bg):
    return Image.new("RGBA", (w, h), bg + (255,) if len(bg) == 3 else bg)


def paste_c(dst, im, cx, cy):
    dst.alpha_composite(im, (int(cx - im.width / 2), int(cy - im.height / 2)))


def mag(im, k):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


W, H = 1700, 1720
sheet = Image.new("RGBA", (W, H), SHEET + (255,))
d = ImageDraw.Draw(sheet)
f = ImageFont.truetype(FONT, 20)
fs = ImageFont.truetype(FONT, 16)


def label(x, y, t, small=False, fill=(60, 66, 80)):
    d.text((x, y), t, font=fs if small else f, fill=fill)


def card(x, y, w, h, bg):
    d.rounded_rectangle((x, y, x + w, y + h), 14, fill=bg)


WHITE, DARK = (255, 255, 255), INK

# ---- row 1: reference vs master
y = 30
label(40, y, "Owner reference (1024 px, scaled to 512)")
label(620, y, "brand/openbase-mark.svg @ 512 px")
label(1200, y, "Overlay: reference 50% + SVG 50%")
y += 34
card(40, y, 540, 540, WHITE)
if not REF:
    raise SystemExit("usage: preview.py <reference.png>")
ref = Image.open(REF).convert("RGBA").resize((512, 512), Image.LANCZOS)
sheet.alpha_composite(ref, (54, y + 14))
card(620, y, 540, 540, WHITE)
m = render(f"{B}/openbase-mark.svg", 512)
# the master has modest padding; the reference has ~7% padding too, so compare at equal canvas
sheet.alpha_composite(m, (634, y + 14))
card(1200, y, 460, 540, WHITE)
# overlay: scale master so hexagon height matches reference (ref hex 782/1024 of canvas; master 352/400)
sc = (782 / 1024) / (352 / 400)
mm = render(f"{B}/openbase-mark.svg", int(512 * sc))
base = Image.new("RGBA", (512, 512), WHITE + (255,))
paste_c(base, mm, 256, 256 + (469 - 512) / 1024 * 512)
ov = Image.blend(ref.convert("RGB"), base.convert("RGB"), 0.5).convert("RGBA")
sheet.alpha_composite(ov.resize((432, 432), Image.LANCZOS), (1214, y + 54))

# ---- row 2: variants
y += 580
label(40, y, "Variants: small (16-32 px) | mono on light | mono on dark | app icon | app icon dark | maskable (safe circle)")
y += 34
cell = 260
xs = [40 + i * 275 for i in range(6)]
card(xs[0], y, cell, cell, WHITE)
paste_c(sheet, render(f"{B}/openbase-mark-small.svg", 220), xs[0] + cell / 2, y + cell / 2)
card(xs[1], y, cell, cell, WHITE)
paste_c(sheet, render_mono(f"{B}/openbase-mark-mono.svg", 220, "#0B1220"), xs[1] + cell / 2, y + cell / 2)
card(xs[2], y, cell, cell, DARK)
paste_c(sheet, render_mono(f"{B}/openbase-mark-mono.svg", 220, "#E8EDF7"), xs[2] + cell / 2, y + cell / 2)
card(xs[3], y, cell, cell, (226, 229, 235))
paste_c(sheet, render(f"{B}/openbase-app-icon.svg", 224), xs[3] + cell / 2, y + cell / 2)
card(xs[4], y, cell, cell, (226, 229, 235))
paste_c(sheet, render(f"{B}/openbase-app-icon-dark.svg", 224), xs[4] + cell / 2, y + cell / 2)
card(xs[5], y, cell, cell, (226, 229, 235))
mk = render(f"{B}/openbase-app-icon-maskable.svg", 224)
paste_c(sheet, mk, xs[5] + cell / 2, y + cell / 2)
dd = ImageDraw.Draw(sheet)
cx, cy = xs[5] + cell / 2, y + cell / 2
r = 224 * 0.4
dd.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(220, 38, 38, 255), width=2)

# ---- row 3: lockups
y += cell + 36
label(40, y, "Lockup (outlined text) on light | dark variant on #0B1220")
y += 34
lw, lh = 810, 190
card(40, y, lw, lh, WHITE)
lk = render(f"{B}/openbase-lockup.svg", 700, None) if False else None
png = subprocess.check_output(["rsvg-convert", "-w", "720", f"{B}/openbase-lockup.svg"])
lk = Image.open(io.BytesIO(png)).convert("RGBA")
paste_c(sheet, lk, 40 + lw / 2, y + lh / 2)
card(40 + lw + 20, y, lw, lh, DARK)
png = subprocess.check_output(["rsvg-convert", "-w", "720", f"{B}/openbase-lockup-dark.svg"])
lk = Image.open(io.BytesIO(png)).convert("RGBA")
paste_c(sheet, lk, 40 + lw + 20 + lw / 2, y + lh / 2)

# ---- row 4: small sizes
y += lh + 36
label(40, y, "Real sizes 16 / 32 / 64 px: actual pixels, then 5x magnified (16, 32) and 2x (64)")
y += 34
for ci, (bg, name) in enumerate(((WHITE, "white"), (DARK, "dark"))):
    x0 = 40 + ci * 830
    card(x0, y, 810, 360, bg)
    ink = (60, 66, 80) if bg == WHITE else (170, 180, 200)
    for ri, (svg, tag) in enumerate(((f"{B}/openbase-mark-small.svg", "small variant"), (f"{B}/openbase-mark.svg", "master"))):
        yy = y + 16 + ri * 172
        d.text((x0 + 16, yy), tag, font=fs, fill=ink)
        xx = x0 + 16
        for sz in (16, 32, 64):
            tile = Image.new("RGBA", (sz, sz), bg + (255,))
            tile.alpha_composite(render(svg, sz))
            sheet.alpha_composite(tile, (xx, yy + 40))
            xx += sz + 14
        mx = x0 + 170
        for sz, k in ((16, 5), (32, 5), (64, 2)):
            tile = Image.new("RGBA", (sz, sz), bg + (255,))
            tile.alpha_composite(render(svg, sz))
            big = mag(tile, k)
            sheet.alpha_composite(big, (mx, yy + 8))
            mx += big.width + 22

sheet.convert("RGB").save(f"{B}/preview.png", optimize=True)
print("preview", sheet.size)
