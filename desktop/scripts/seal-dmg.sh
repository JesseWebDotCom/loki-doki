#!/usr/bin/env bash
# Reference DMGTOOL for build-mac-on-windows.ts: seal a prepared staging folder
# into a compressed .dmg WITHOUT macOS, using libdmg-hfsplus. Runs on Linux or on
# Windows under WSL (point DMGTOOL at "wsl /path/to/seal-dmg.sh").
#
# Contract (the build script calls this as):
#   seal-dmg.sh <root-dir> <out.dmg> <volume-name>
# where <root-dir> already contains "<Name>.app", ".background/dmg-background.png"
# (+@2x) and ".DS_Store". This script adds the /Applications symlink and hides
# the .background folder itself.
#
# Requirements (install/build once on the Windows/WSL box):
#   - hfsprogs           -> provides mkfs.hfsplus   (apt-get install hfsprogs)
#   - libdmg-hfsplus     -> provides the `hfsplus` and `dmg` tools on PATH
#                           (build from https://github.com/planetbeing/libdmg-hfsplus)
#
# NOTE: libdmg-hfsplus is experimental and its subcommand surface varies by fork.
# The `addall`/`symlink`/`chflags` calls below match the planetbeing/redbooth
# forks; if yours differs, adjust here. This is the one step that cannot be
# validated from macOS, so run it once and confirm the resulting DMG mounts and
# shows the styled window before relying on it in a release.
set -euo pipefail

ROOT="$1"; OUT="$2"; VOL="$3"
command -v mkfs.hfsplus >/dev/null || { echo "mkfs.hfsplus missing (install hfsprogs)" >&2; exit 1; }
command -v hfsplus      >/dev/null || { echo "hfsplus tool missing (build libdmg-hfsplus)" >&2; exit 1; }
command -v dmg          >/dev/null || { echo "dmg tool missing (build libdmg-hfsplus)" >&2; exit 1; }

# Size the raw image to the payload plus headroom for HFS+ metadata.
SIZE_MB=$(( $(du -sm "$ROOT" | cut -f1) + 40 ))
IMG="$(mktemp -u).hfs"
trap 'rm -f "$IMG"' EXIT

dd if=/dev/zero of="$IMG" bs=1M count="$SIZE_MB" status=none
mkfs.hfsplus -v "$VOL" "$IMG"

# Populate: whole tree (preserves the .app's internal symlinks + modes), then the
# Applications drop target and the invisible flag on the background folder.
hfsplus "$IMG" addall "$ROOT"
hfsplus "$IMG" symlink Applications /Applications
hfsplus "$IMG" chflags hidden .background || true

# Compress to a UDIF (UDZO) image that Finder mounts like any DMG.
rm -f "$OUT"
dmg build "$IMG" "$OUT"
echo "sealed $OUT ($VOL)"
