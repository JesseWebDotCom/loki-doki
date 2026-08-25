#!/bin/sh
# MaiPai Home installer for macOS and Linux.
# Usage:  curl -fsSL https://getmaipai.github.io/home/install.sh | sh
set -e

DIR="${MAIPAI_DIR:-$HOME/maipai-home}"
REPO="https://github.com/getmaipai/home.git"

echo ""
echo "  Installing MaiPai Home..."
echo ""

command -v git >/dev/null 2>&1 || { echo "  Please install git first (https://git-scm.com), then run this again."; exit 1; }

TAG=$(git ls-remote --tags --sort=-v:refname "$REPO" 'v*' | head -1 | sed 's/.*refs\/tags\///; s/\^{}//')
[ -n "$TAG" ] || { echo "  Could not find the latest release. Check your internet connection."; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "  Found an existing install at $DIR, updating it to $TAG..."
  git -C "$DIR" fetch --tags -q origin
else
  echo "  Downloading MaiPai Home $TAG into $DIR..."
  git clone -q "$REPO" "$DIR"
fi
git -C "$DIR" checkout -q "$TAG"

echo "  Starting MaiPai Home (first start downloads what it needs)..."
cd "$DIR"
exec ./run.sh
