#!/usr/bin/env bash
# Bake the Finder window layout for the Doki Dock install DMG into a reusable
# .DS_Store, committed at build/dmg/DS_Store. The Windows build path
# (build-mac-on-windows.ts) drops this file into the DMG it assembles so the
# install window looks identical to the one electron-builder produces on CI,
# WITHOUT needing a Mac at build time.
#
# macOS ONLY (needs hdiutil + a real Finder session via osascript). Run once,
# whenever the layout in make-dmg-background.sh / electron-builder.yml changes,
# then commit build/dmg/DS_Store. The controlling terminal needs Automation
# permission to control Finder (macOS may prompt on first run; approve it).
#
# Usage: scripts/make-dsstore.sh
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
BG="$DESKTOP/build/dmg-background.png"
BG2X="$DESKTOP/build/dmg-background@2x.png"
OUT_DIR="$DESKTOP/build/dmg"
OUT="$OUT_DIR/DS_Store"

# ── LAYOUT (must match make-dmg-background.sh + electron-builder.yml) ──────────
VOL="Doki Dock"          # volume name; the real DMG MUST use the same volname
WIN_W=600; WIN_H=420
ICON_SIZE=112
APP_NAME="Doki Dock.app"
APP_X=150; APP_Y=215
APPS_X=450; APPS_Y=215
# ──────────────────────────────────────────────────────────────────────────────

[ "$(uname)" = "Darwin" ] || { echo "macOS only (needs Finder/hdiutil)" >&2; exit 1; }
[ -f "$BG" ] || { echo "missing $BG (run make-dmg-background.sh first)" >&2; exit 1; }

WORK="$(mktemp -d)"
DMG="$WORK/stage.dmg"
MNT="/Volumes/$VOL"
cleanup() {
  hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# A blank read/write image we can arrange in Finder, then read .DS_Store back.
hdiutil create -size 64m -fs HFS+ -volname "$VOL" -ov -quiet "$DMG"
hdiutil attach "$DMG" -nobrowse -quiet

# Stub contents: an item named exactly like the real app (Finder keys layout on
# the name), the /Applications drop target, and the background under .background.
mkdir -p "$MNT/$APP_NAME" "$MNT/.background"
cp "$BG" "$MNT/.background/dmg-background.png"
[ -f "$BG2X" ] && cp "$BG2X" "$MNT/.background/dmg-background@2x.png"
ln -s /Applications "$MNT/Applications"

# Window bounds: content region WIN_W x WIN_H at an arbitrary screen origin.
X0=200; Y0=120
X1=$((X0 + WIN_W)); Y1=$((Y0 + WIN_H))

# Clear any cached window geometry Finder holds for a "$VOL" volume so the bounds
# we set below are the ones that persist (otherwise a stale size wins → no bwsp).
osascript -e 'tell application "Finder" to close windows' 2>/dev/null || true

# Sequence mirrors create-dmg: set everything, close, re-open + update, and leave
# the window OPEN so Finder flushes bwsp (window bounds) into .DS_Store. Closing
# too early writes icvp/Iloc but drops bwsp, so the window opens at a stale size.
osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOL"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {$X0, $Y0, $X1, $Y1}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to $ICON_SIZE
    set background picture of theViewOptions to file ".background:dmg-background.png"
    set position of item "$APP_NAME" of container window to {$APP_X, $APP_Y}
    set position of item "Applications" of container window to {$APPS_X, $APPS_Y}
    close
    open
    set the bounds of container window to {$X0, $Y0, $X1, $Y1}
    update without registering applications
    delay 3
  end tell
end tell
APPLESCRIPT

# Let Finder flush the layout to disk before we read it back.
sync
sleep 1

[ -f "$MNT/.DS_Store" ] || { echo "Finder did not write a .DS_Store (Automation permission blocked?)" >&2; exit 1; }
mkdir -p "$OUT_DIR"
cp "$MNT/.DS_Store" "$OUT"
echo "wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
