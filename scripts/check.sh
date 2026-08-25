#!/usr/bin/env bash
# MaiPai Home pre-commit gate (org standard): build checks + secret/PII scan.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== backend build check"
(cd backend && bun run check:build)

echo "== frontend typecheck"
(cd frontend && bunx tsc -b)

echo "== design contract"
(cd frontend && bun run check:design-contract)

echo "== gitleaks"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks dir --no-banner --redact . && gitleaks git --no-banner --redact . || { echo "gitleaks found problems"; exit 1; }
else
  echo "WARN: gitleaks not installed (brew install gitleaks)"
fi

echo "== PII wordlist"
WORDS="$HOME/.config/maipai/pii-words.txt"
if [ -f "$WORDS" ]; then
  PATTERN=$(grep -v '^#' "$WORDS" | grep -v '^$' | paste -sd'|' -)
  if [ -n "$PATTERN" ]; then
    HITS=$(git grep -inE "$PATTERN" -- ':!*.lock' 2>/dev/null | head -20 || true)
    if [ -n "$HITS" ]; then
      echo "PII wordlist hits found:"; echo "$HITS"; exit 1
    fi
  fi
else
  echo "WARN: no PII wordlist at $WORDS"
fi
echo "== all checks passed"
