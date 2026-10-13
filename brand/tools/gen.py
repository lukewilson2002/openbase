#!/usr/bin/env python3
"""OpenBase mark generator: exact isometric 2x2x2 cube with the front-top cube removed.

Model: cube [0,2]^3 seen down the (1,1,1) diagonal.
  screen X = (y - x) * c * s,  screen Y = ((x + y) / 2 - z) * s,  c = cos30
The corner (1,1,1) (cube centre) projects to the hexagon centre.
Faces are convex (except the sliver chevron) polygons; internal edges are
inset by gap/2 so every gap is a genuine, uniform-width hole.
"""
import math
C = math.sqrt(3) / 2


class Mark:
    def __init__(self, s=88.0, cx=200.0, cy=200.0, gap=0.042, delta=0.17,
                 sliver=True, gap_mode="all", gap_px=None):
        self.s, self.cx, self.cy = s, cx, cy
        self.w = gap_px if gap_px is not None else gap * s
        self.delta = delta if sliver else 0.0
        self.sliver = sliver
        self.gap_mode = gap_mode  # "all" or "same" (only between same-colour faces)

    def P(self, x, y, z):
        return (self.cx + (y - x) * C * self.s, self.cy + ((x + y) / 2 - z) * self.s)

    def hexagon(self):
        return [self.P(0, 0, 2), self.P(0, 2, 2), self.P(0, 2, 0), self.P(2, 2, 0), self.P(2, 0, 0), self.P(2, 0, 2)]
        # order: top, upper-right, lower-right, bottom, lower-left, upper-left (screen) -> see below

    def faces(self):
        P, d = self.P, self.delta
        F = []  # (name, kind, [pts])
        for i, j in ((0, 0), (1, 0), (0, 1)):
            F.append((f"top{i}{j}", "top", [P(i, j, 2), P(i + 1, j, 2), P(i + 1, j + 1, 2), P(i, j + 1, 2)]))
        for j, k in ((0, 0), (0, 1), (1, 0)):
            F.append((f"left{j}{k}", "left", [P(2, j, k), P(2, j + 1, k), P(2, j + 1, k + 1), P(2, j, k + 1)]))
        for i, k in ((0, 0), (0, 1), (1, 0)):
            F.append((f"right{i}{k}", "right", [P(i, 2, k), P(i + 1, 2, k), P(i + 1, 2, k + 1), P(i, 2, k + 1)]))
        z = 1 + d
        V, L, B, R = P(1, 1, z), P(2, 1, z), P(2, 2, z), P(1, 2, z)
        T, TL, TR = P(1, 1, 2), P(2, 1, 2), P(1, 2, 2)
        F.append(("floor", "floor", [V, L, B, R]))
        F.append(("wallL", "wallL", [V, L, TL, T]))
        F.append(("wallR", "wallR", [V, R, TR, T]))
        if self.sliver and d > 0:
            Q, Q2 = P(2, 1, 1), P(1, 2, 1)
            Bf = P(2, 2, 1)
            # intersection of floor edge L->B with Rtop edge Q->V1 (V1 = P(1,1,1))
            Rl = (Q[0] + C * d * self.s, Q[1] - 0.5 * d * self.s)
            Rr = (Q2[0] - C * d * self.s, Q2[1] - 0.5 * d * self.s)
            F.append(("sliver", "sliver", [Q, Rl, B, Rr, Q2, Bf]))
            F.append(("triL", "sliver", [L, Q, Rl]))
            F.append(("triR", "sliver", [R, Rr, Q2]))
        return F


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_seg(a, b, p, eps=1e-6):
    if abs(cross(a, b, p)) > eps * max(1, math.dist(a, b)) * 10:
        return False
    return min(a[0], b[0]) - eps <= p[0] <= max(a[0], b[0]) + eps and min(a[1], b[1]) - eps <= p[1] <= max(a[1], b[1]) + eps


def area(poly):
    return sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly))) / 2


def offset_poly(poly, offs):
    """Shift each edge i (poly[i]->poly[i+1]) inward by offs[i]; re-intersect neighbours."""
    n = len(poly)
    sgn = 1 if area(poly) > 0 else -1  # in screen coords (y down) orientation sign
    lines = []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        # inward normal: for positive-area (in y-down coords => clockwise visually) polygon, inward = (-dy, dx)/L
        nx, ny = (-dy / L, dx / L) if sgn > 0 else (dy / L, -dx / L)
        # sanity: inward means toward centroid
        lines.append(((a[0] + nx * offs[i], a[1] + ny * offs[i]), (dx, dy)))
    out = []
    for i in range(n):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        den = d1[0] * d2[1] - d1[1] * d2[0]
        t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
        out.append((p1[0] + d1[0] * t, p1[1] + d1[1] * t))
    return out


def build(mark, same_group=None):
    """Return list of (name, kind, polygon) with gaps applied."""
    F = mark.faces()
    hexa = [mark.P(0, 0, 2), mark.P(0, 2, 2), mark.P(0, 2, 0), mark.P(2, 2, 0), mark.P(2, 0, 0), mark.P(2, 0, 2)]
    hedges = [(hexa[i], hexa[(i + 1) % 6]) for i in range(6)]
    amber = {"floor", "wallL", "wallR"}

    def outer(a, b):
        return any(on_seg(h0, h1, a) and on_seg(h0, h1, b) for h0, h1 in hedges)

    def find_neighbour(name, a, b):
        # sample 3 points along the edge; return the kind of the first other face with that point on its boundary
        for t in (0.5, 0.25, 0.75):
            p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            for n2, k2, poly2 in F:
                if n2 == name:
                    continue
                for i in range(len(poly2)):
                    if on_seg(poly2[i], poly2[(i + 1) % len(poly2)], p):
                        return k2
        return None

    res = []
    for name, kind, poly in F:
        offs = []
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            if outer(a, b):
                offs.append(0.0)
                continue
            nk = find_neighbour(name, a, b)
            if kind in ("floor", "wallL", "wallR") and nk in ("floor", "wallL", "wallR"):
                offs.append(0.0)
            elif mark.gap_mode == "same" and nk is not None and nk != kind:
                offs.append(0.0)
            else:
                offs.append(mark.w / 2)
        res.append((name, kind, offset_poly(poly, offs)))
    return res


def fmt(v):
    s = f"{v:.1f}"
    if s.endswith(".0"):
        s = s[:-2]
    if s == "-0":
        s = "0"
    return s


def path_d(poly):
    return "M" + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in poly) + "z"


def polys_svg(faces, colours, opacity=None, indent="  "):
    """Group faces by colour into one <path> per colour (compact)."""
    order = []
    groups = {}
    for name, kind, poly in faces:
        key = colours[kind]
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(poly)
    out = []
    for key in order:
        d = "".join(path_d(p) for p in groups[key])
        out.append(f'{indent}<path fill="{key}" d="{d}"/>')
    return "\n".join(out)


BRAND = dict(top="#6B97FF", left="#1F5AE0", right="#12358A", wallL="#F9B74B", wallR="#DB871B", floor="#F5A524")
BRAND["sliver"] = BRAND["top"]


def bounds(mark):
    xs = [p[0] for p in (mark.P(0, 0, 2), mark.P(2, 0, 0), mark.P(0, 2, 0))]
    return mark


if __name__ == "__main__":
    m = Mark()
    for n, k, p in build(m):
        print(n, [(round(x, 1), round(y, 1)) for x, y in p])
