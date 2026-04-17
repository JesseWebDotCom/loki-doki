"""Tests for entity alias canonicalization."""
from __future__ import annotations

import json
import os
import tempfile

import pytest

from lokidoki.orchestrator.pipeline import entity_aliases as mod
from lokidoki.orchestrator.pipeline.entity_aliases import canonicalize_entities


# --- text replacement ---------------------------------------------------------

def test_alias_replaces_in_text():
    text, entities = canonicalize_entities("my mbp is overheating", [])
    assert "MacBook Pro" in text
    assert "mbp" not in text.lower().split()


def test_alias_replaces_in_entities():
    entities = [("mbp", "PRODUCT")]
    text, updated = canonicalize_entities("check my mbp", entities)
    assert updated == [("MacBook Pro", "PRODUCT")]
    assert "MacBook Pro" in text


def test_unknown_alias_passes_through():
    text, entities = canonicalize_entities("check my xyz123", [("xyz123", "PRODUCT")])
    assert text == "check my xyz123"
    assert entities == [("xyz123", "PRODUCT")]


def test_case_insensitive_match():
    text, _ = canonicalize_entities("I love my MBP", [])
    assert "MacBook Pro" in text


def test_multiple_aliases():
    text, _ = canonicalize_entities("mbp vs mba for coding", [])
    assert "MacBook Pro" in text
    assert "MacBook Air" in text


# --- word boundary ------------------------------------------------------------

def test_no_partial_replacement():
    """'ha' should not replace inside 'have' or 'that'."""
    text, _ = canonicalize_entities("I have that handled", [])
    assert text == "I have that handled"


# --- missing data file --------------------------------------------------------

def test_missing_data_file_returns_empty(monkeypatch):
    """When alias file doesn't exist, canonicalize is a no-op."""
    monkeypatch.setattr(mod, "_ALIASES", {})
    text, entities = canonicalize_entities("mbp is great", [("mbp", "PRODUCT")])
    assert text == "mbp is great"
    assert entities == [("mbp", "PRODUCT")]
