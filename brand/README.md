# OpenBase brand assets

The mark is a 2x2x2 cube in true isometric projection (outline: a regular hexagon). The cube at the
corner nearest the viewer is removed, so you look into the notch and see three amber inner faces.
A thin light-blue sliver of the lower-front block's top face shows under the amber floor.

All geometry is computed, not traced (`tools/gen.py`): every edge is exactly parallel to one of three
axes, and every gap is a real hole of one width (internal edges are inset by half a gap), so the
mark works on any background. Gaps are not white strokes.

## Palette

| Role | Hex | Used for |
| --- | --- | --- |
| Top | `#6B97FF` | top faces and the sliver |
| Left | `#1F5AE0` | left faces |
| Right | `#12358A` | right faces |
| Amber wall, left | `#F9B74B` | notch left wall |
| Amber wall, right | `#DB871B` | notch right wall |
| Amber floor | `#F5A524` | notch floor |
| Ink | `#0B1220` | wordmark on light, dark icon background |
| White | `#FFFFFF` | wordmark on dark, light icon background |

The values match the app tokens. The owner's reference image samples slightly differently
(top `#618FFB`, left `#1F57D3`, right `#133586`); the brand tokens were used for consistency.

## Files

| File | Purpose |
| --- | --- |
| `openbase-mark.svg` | Master mark. Transparent, 400x400 viewBox, about 6% padding. |
| `openbase-mark-small.svg` | 16-32 px variant: wider gaps (6% of the canvas), no sliver, hexagon fills the canvas. |
| `openbase-mark-mono.svg` | One colour (`currentColor`), faces separated by gaps and opacity steps. |
| `openbase-app-icon.svg` | Mark on a white rounded square (512 grid). |
| `openbase-app-icon-dark.svg` | Same on `#0B1220`. |
| `openbase-app-icon-maskable.svg` | Same on a full-bleed white square (no rounded corners), for maskable and apple-touch icons. |
| `openbase-lockup.svg` | Mark plus "OpenBase" (outlined paths, no font needed), for light backgrounds. |
| `openbase-lockup-dark.svg` | Same with a white wordmark, for dark backgrounds. Transparent, no backdrop. |
| `favicon.ico` | 16, 32 and 48 px, built from the small variant. |
| `png/favicon-16.png`, `favicon-32.png`, `favicon-48.png` | Small variant. |
| `png/apple-touch-icon.png` | 180 px, full-bleed white (iOS applies its own rounding). |
| `png/icon-192.png`, `icon-512.png` | Web app manifest icons (rounded white icon). |
| `png/icon-maskable-512.png` | Manifest icon with `"purpose": "maskable"`. |
| `preview.png` | Contact sheet: reference vs master, every variant, 16/32/64 px on white and dark. |
| `tools/` | Generator (`gen.py` geometry, `build.py` assets, `preview.py` sheet). |

The app icon artwork sits inside the maskable safe zone: the hexagon circumradius is 34% of the icon
width, and the safe circle is 40%. The same artwork is used for the rounded and maskable versions.

## Usage

- **Clear space:** keep at least one small-cube edge (a quarter of the mark's height) free on all sides.
  The master SVG's built-in padding is smaller than that, so add margin in layout.
- **Minimum size:** master mark 24 px tall; lockup 120 px wide. Below that, switch variants.
- **Small variant:** use for 16-32 px (favicons, tab icons, dense lists, notification badges). Use the
  master from 40 px upward. The sliver and the thin gaps disappear below that and only add noise.
- **Mono variant:** use where colour is not allowed or would clash (toolbars, menus, print, embossing,
  status badges). It uses `currentColor`, so inline the SVG or apply it as a CSS mask; as an `<img>` it
  renders black. On dark backgrounds it reads inverted (the right face is the brightest), which is intended.
- **Backgrounds:** the colour mark works on white, light grey and on `#0B1220`. On busy or mid-tone
  imagery use the app icon tile or the mono variant instead.
- **Lockup:** use `openbase-lockup.svg` on light and `openbase-lockup-dark.svg` on dark. Do not retype
  the name in another font.
- **Do not:** recolour faces, add outlines or shadows, rotate or skew the cube, fill the gaps, or swap
  the amber notch for another colour.

## Regenerating

```sh
python3 -m venv .venv && .venv/bin/pip install fonttools shapely pillow
.venv/bin/python brand/tools/build.py
.venv/bin/python brand/tools/preview.py path/to/reference.png
```

Needs `rsvg-convert`, `magick` and `hb-shape` on PATH. The wordmark is outlined from Outfit SemiBold
(SIL Open Font License 1.1), tracked -8/1000 em; the outlines are the only font-derived artwork and
carry no font dependency.

## Construction (for reference)

Cube `[0,2]^3` viewed along `(1,1,1)`: screen `X = (y-x)*cos30*s`, `Y = ((x+y)/2 - z)*s`, `s` = cube edge
(88 units in the master, hexagon 304.8 x 352). Master gap 4 units (4.5% of `s`). The notch floor is raised
0.17 `s` above the lower blocks' top plane, which produces the light-blue sliver and the two small end
triangles seen in the owner's reference.
