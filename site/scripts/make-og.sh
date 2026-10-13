#!/usr/bin/env bash
# Regenerates public/og.png (1200x630, the Open Graph / social preview image) from the brand
# lockup. Needs rsvg-convert and ImageMagick (magick); the tagline uses the Outfit font the
# brand wordmark was drawn from (SIL OFL). Run from anywhere: scripts/make-og.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
font="${OG_FONT:-/Library/Fonts/Outfit-Medium.ttf}"

rsvg-convert -w 760 "$repo/brand/openbase-lockup-dark.svg" -o "$tmp/lockup.png"
magick -size 1200x630 xc:'#0B1220' \
  \( "$tmp/lockup.png" \) -gravity north -geometry +0+150 -composite \
  -fill '#F5A524' -draw 'rectangle 560,396 640,401' \
  -font "$font" -pointsize 38 -fill '#E8EBF1' -gravity north \
  -annotate +0+430 'Your own Airtable. One small server, no subscriptions.' \
  -pointsize 26 -fill '#8E99AB' -annotate +0+545 'myopenbase.app' \
  -strip "$here/public/og.png"
echo "wrote $here/public/og.png"
