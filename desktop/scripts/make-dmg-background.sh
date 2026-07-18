#!/usr/bin/env bash
# Generate the Doki Dock DMG window background (build/dmg-background.png + @2x)
# from the brand palette. The background holds only the backdrop, the drag arrow,
# and the instructions; Finder paints the real app icon and the /Applications
# shortcut ON TOP at the positions defined in build/dmg/layout (see the LAYOUT
# block below, which MUST stay in sync with electron-builder.yml's dmg.contents
# and scripts/make-dsstore.sh).
#
# Requires ImageMagick 7 (`magick`). Run once on any machine with it installed
# (macOS/Linux/WSL); the PNGs it writes are committed and consumed by BOTH build
# paths (CI electron-builder and the Windows build-mac-on-windows.ts pipeline).
#
# Usage: scripts/make-dmg-background.sh
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
OUT_1X="$DESKTOP/build/dmg-background.png"
OUT_2X="$DESKTOP/build/dmg-background@2x.png"

# ── LAYOUT (canonical; keep in sync with electron-builder.yml + make-dsstore.sh) ──
WIN_W=600         # dmg window content width
WIN_H=420         # dmg window content height
APP_X=150         # app icon center
APP_Y=215
APPS_X=450        # /Applications shortcut center
APPS_Y=215
# ──────────────────────────────────────────────────────────────────────────────

# Brand palette (assets/icons/brand.svg).
BG_TOP="#221636"
BG_BOT="#14101f"
ACCENT="#8b7bff"      # arrow / accent
TITLE_FG="#f4f1ff"
BODY_FG="#b9b0d6"
MUTED_FG="#8d84a8"

# First existing font wins (ImageMagick's type map is unreliable on macOS).
pick_font() {
  for f in \
    /System/Library/Fonts/Helvetica.ttc \
    /System/Library/Fonts/SFNS.ttf \
    /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    /Library/Fonts/Arial.ttf; do
    [ -f "$f" ] && { echo "$f"; return; }
  done
  echo "Helvetica"   # let ImageMagick try its own resolver as a last resort
}
FONT="$(pick_font)"
FONT_BOLD="$FONT"
[ -f /System/Library/Fonts/HelveticaNeue.ttc ] && FONT_BOLD=/System/Library/Fonts/HelveticaNeue.ttc

command -v magick >/dev/null || { echo "ImageMagick 7 (magick) is required" >&2; exit 1; }

# Render at 2x, then downscale for the 1x asset so both stay crisp.
W2=$((WIN_W * 2)); H2=$((WIN_H * 2))
sx() { echo $(( $1 * 2 )); }   # scale a 1x coord to 2x

# Arrow: horizontal shaft + head, centered between the two icons at icon-Y.
ARROW_Y=$(sx "$APP_Y")
ARROW_X0=$(sx $((APP_X + 95)))    # just right of the app icon
ARROW_X1=$(sx $((APPS_X - 95)))   # just left of the Applications icon
HEAD=28

magick -size "${W2}x${H2}" \
    "gradient:${BG_TOP}-${BG_BOT}" \
    \( +clone -sparse-color barycentric "0,0 ${BG_TOP} ${W2},${H2} ${BG_BOT}" \) \
    -delete 0 \
    -font "$FONT_BOLD" -fill "$TITLE_FG" -pointsize 52 -gravity North \
    -annotate +0+56 "Install Doki Dock" \
    -font "$FONT" -fill "$BODY_FG" -pointsize 30 -gravity North \
    -annotate +0+130 "Drag the app onto the Applications folder" \
    -stroke "$ACCENT" -strokewidth 10 -fill "$ACCENT" \
    -draw "line ${ARROW_X0},${ARROW_Y} ${ARROW_X1},${ARROW_Y}" \
    -draw "polygon $((ARROW_X1)),$((ARROW_Y - HEAD)) $((ARROW_X1 + 46)),${ARROW_Y} $((ARROW_X1)),$((ARROW_Y + HEAD))" \
    -stroke none \
    -font "$FONT" -fill "$MUTED_FG" -pointsize 24 -gravity North \
    -annotate +0+656 "First open is blocked by macOS (the app is not signed)." \
    -font "$FONT" -fill "$MUTED_FG" -pointsize 24 -gravity North \
    -annotate +0+690 "Open System Settings > Privacy & Security, then click \"Open Anyway\"." \
    "$OUT_2X"

magick "$OUT_2X" -resize "${WIN_W}x${WIN_H}" "$OUT_1X"

echo "wrote $OUT_1X (${WIN_W}x${WIN_H})"
echo "wrote $OUT_2X (${W2}x${H2})"
