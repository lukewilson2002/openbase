#!/usr/bin/env python3
"""Build every OpenBase brand asset into brand/.

Run:  python3 -m venv .venv && .venv/bin/pip install fonttools shapely pillow
      .venv/bin/python brand/tools/build.py && .venv/bin/python brand/tools/preview.py [reference.png]
Needs rsvg-convert, magick and hb-shape on PATH, and Outfit-SemiBold.ttf (SIL OFL) for the wordmark.
"""
import sys, os, subprocess, json
D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, D)
from gen import *
from shapely.geometry import Polygon
from shapely.ops import unary_union
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = os.path.dirname(D)  # brand/
os.makedirs(OUT + "/png", exist_ok=True)

GAP = 4 / 88  # master gap as a fraction of the cube edge s
INK = "#0B1220"


def seamless(faces):
    """Paint the amber floor as the union of the three amber faces so the walls overlay it
    (no anti-aliasing hairline between faces that deliberately have no gap)."""
    amber = [Polygon(p).buffer(1e-3, join_style=2) for n, k, p in faces if k in ("floor", "wallL", "wallR")]
    u = unary_union(amber).simplify(0.02)
    ring = list(u.exterior.coords)[:-1]
    return [(n, k, ring if k == "floor" else p) for n, k, p in faces]


def write(name, text):
    with open(f"{OUT}/{name}", "w") as f:
        f.write(text if text.endswith("\n") else text + "\n")


def svg(vb_w, vb_h, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(vb_w)} {fmt(vb_h)}">\n{body}\n</svg>'


# ---------------------------------------------------------------- master
master = Mark(s=88, cx=200, cy=200, gap_px=4, delta=0.17)
write("openbase-mark.svg", svg(400, 400, polys_svg(seamless(build(master)), BRAND)))

# ---------------------------------------------------------------- small (16-32 px)
small = Mark(s=8, cx=16, cy=16, gap_px=2, sliver=False)
write("openbase-mark-small.svg", svg(32, 32, polys_svg(seamless(build(small)), BRAND)))

# ---------------------------------------------------------------- mono
MONO = dict(top=0.55, left=0.78, right=1.0, wallL=0.26, wallR=0.40, floor=0.16, sliver=0.55)


def mono_svg(mark, vb):
    groups = {}
    for name, kind, poly in build(mark):
        groups.setdefault(MONO[kind], []).append(poly)
    lines = []
    for op in sorted(groups, reverse=True):
        d = "".join(path_d(p) for p in groups[op])
        a = "" if op == 1.0 else f' fill-opacity="{op:g}"'
        lines.append(f'  <path{a} d="{d}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb} {vb}" fill="currentColor">\n' + "\n".join(lines) + "\n</svg>"


write("openbase-mark-mono.svg", mono_svg(master, 400))

# ---------------------------------------------------------------- app icons (512 grid)
ICON_S = 88.0  # hex circumradius 176 = 34.4% of 512 -> inside the 40% maskable safe circle


def icon_svg(bg, rounded):
    m = Mark(s=ICON_S, cx=256, cy=256, gap_px=ICON_S * GAP, delta=0.17)
    rx = ' rx="112"' if rounded else ""
    return svg(512, 512, f'  <rect width="512" height="512"{rx} fill="{bg}"/>\n' + polys_svg(seamless(build(m)), BRAND))


write("openbase-app-icon.svg", icon_svg("#FFFFFF", True))
write("openbase-app-icon-dark.svg", icon_svg(INK, True))
write("openbase-app-icon-maskable.svg", icon_svg("#FFFFFF", False))

# ---------------------------------------------------------------- lockup (text -> outlines)
FONT = "/Library/Fonts/Outfit-SemiBold.ttf"
TEXT = "OpenBase"


def wordmark_path(x0, baseline, scale, tracking):
    font = TTFont(FONT)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    shaped = json.loads(subprocess.check_output(["hb-shape", FONT, TEXT, "--output-format=json"]))
    x = x0
    parts = []
    for g in shaped:
        pen = SVGPathPen(gs, ntos=lambda v: fmt(v))
        tp = TransformPen(pen, (scale, 0, 0, -scale, x, baseline))
        gs[g["g"]].draw(tp)
        parts.append(pen.getCommands())
        x += (g["ax"] + tracking) * scale
    return "".join(parts), x - tracking * scale


def lockup(ink):
    pad = 24
    mh = 352.0
    m = Mark(s=88, cx=pad + 152.4, cy=pad + 176, gap_px=4)
    mark = polys_svg(seamless(build(m)), BRAND)
    cap = 140.0  # cap height in svg units
    scale = cap / 700.0
    base = pad + mh / 2 + cap / 2
    d, xend = wordmark_path(pad + 304.8 + 76, base, scale, -8)
    w = xend + pad
    body = mark + f'\n  <path fill="{ink}" d="{d}"/>'
    return svg(w, mh + 2 * pad, body)


write("openbase-lockup.svg", lockup(INK))
write("openbase-lockup-dark.svg", lockup("#FFFFFF"))

# ---------------------------------------------------------------- rasters
def rsvg(src, dst, w, h=None, bg=None):
    cmd = ["rsvg-convert", "-w", str(w), "-h", str(h or w)]
    if bg:
        cmd += ["-b", bg]
    subprocess.check_call(cmd + [src, "-o", dst])


P = OUT + "/png/"
rsvg(OUT + "/openbase-mark-small.svg", P + "favicon-16.png", 16)
rsvg(OUT + "/openbase-mark-small.svg", P + "favicon-32.png", 32)
rsvg(OUT + "/openbase-mark-small.svg", P + "favicon-48.png", 48)
rsvg(OUT + "/openbase-app-icon-maskable.svg", P + "apple-touch-icon.png", 180)  # full-bleed; iOS rounds it
rsvg(OUT + "/openbase-app-icon.svg", P + "icon-192.png", 192)
rsvg(OUT + "/openbase-app-icon.svg", P + "icon-512.png", 512)
rsvg(OUT + "/openbase-app-icon-maskable.svg", P + "icon-maskable-512.png", 512)
subprocess.check_call(["magick", P + "favicon-16.png", P + "favicon-32.png", P + "favicon-48.png", OUT + "/favicon.ico"])
print("built")
