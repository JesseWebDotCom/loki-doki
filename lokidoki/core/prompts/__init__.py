"""Prompt strings for the LokiDoki pipeline.

Each prompt lives in its own module so it can be edited, diffed, and
unit-tested without dragging in the surrounding orchestration code.
This package is intentionally NOT a template framework — modules export
plain strings (or simple ``str.format`` templates), nothing more.
"""
from lokidoki.core.prompts.decomposition import DECOMPOSITION_PROMPT

__all__ = ["DECOMPOSITION_PROMPT"]
