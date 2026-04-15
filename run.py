"""Deprecated — forwards to ``python -m lokidoki.bootstrap``.

Kept briefly so existing muscle memory (``uv run run.py``) still lands on
the new Layer 1 installer. Chunk 9 of docs/bootstrap_rewrite/PLAN.md
deletes this file outright.
"""
import os
import sys

print(
    "run.py is deprecated — forwarding to `python -m lokidoki.bootstrap`.",
    file=sys.stderr,
)
os.execvp(sys.executable, [sys.executable, "-m", "lokidoki.bootstrap", *sys.argv[1:]])
