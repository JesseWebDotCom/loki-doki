#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Detect the best python binary to use (respect active venv)
if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then
  PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  PYTHON_BIN="python3"
fi

# Parse --force-installer flag
FORCE_INSTALLER=""
for arg in "$@"; do
  if [ "$arg" = "--force-installer" ]; then
    FORCE_INSTALLER=1
    # Remove the flag from positional args
    set -- "${@/--force-installer}"
    break
  fi
done

if [ -n "$FORCE_INSTALLER" ]; then
  exec env FORCE_INSTALLER=1 "$PYTHON_BIN" run.py "$@"
else
  exec "$PYTHON_BIN" run.py "$@"
fi
