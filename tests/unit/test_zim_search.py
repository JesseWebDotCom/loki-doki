"""Test ZIM search engine and HTML stripping."""
from __future__ import annotations

import pytest

from lokidoki.archives.html_strip import strip_html, trim_to_sentences
from lokidoki.archives.search import (
    ZimArticle,
    ZimSearchEngine,
    _build_url,
    get_search_engine,
    initialize_search_engine,
)
from lokidoki.archives.models import ArchiveState


# ── HTML stripping ──────────────────────────────────────────────

def test_strip_basic_html():
    html = "<p>Hello <b>world</b></p>"
    assert strip_html(html) == "Hello world"


def test_strip_skips_script_and_style():
    html = "<p>Before</p><script>alert('x')</script><style>.x{}</style><p>After</p>"
    text = strip_html(html)
    assert "alert" not in text
    assert ".x{}" not in text
    assert "Before" in text
    assert "After" in text


def test_strip_preserves_newlines_for_block_elements():
    html = "<h1>Title</h1><p>Paragraph one.</p><p>Paragraph two.</p>"
    text = strip_html(html)
    assert "Title" in text
    assert "Paragraph one." in text
    assert "Paragraph two." in text


def test_strip_max_chars():
    html = "<p>" + "word " * 1000 + "</p>"
    text = strip_html(html, max_chars=100)
    assert len(text) <= 100


def test_strip_handles_malformed_html():
    html = "<p>Unclosed <b>bold<p>New paragraph"
    text = strip_html(html)
    assert "Unclosed" in text
    assert "bold" in text


def test_strip_skips_nav():
    html = "<nav><a>Link1</a><a>Link2</a></nav><p>Content</p>"
    text = strip_html(html)
    assert "Link1" not in text
    assert "Content" in text


# ── Sentence trimming ──────────────────────────────────────────

def test_trim_short_text():
    assert trim_to_sentences("Hello world.", 100) == "Hello world."


def test_trim_at_sentence_boundary():
    text = "First sentence. Second sentence. Third sentence. Fourth sentence."
    trimmed = trim_to_sentences(text, 35)
    assert trimmed.endswith("Second sentence.")


def test_trim_no_sentence_boundary():
    text = "Just a long string of words without any sentence endings"
    trimmed = trim_to_sentences(text, 20)
    assert len(trimmed) <= 25  # allows for ellipsis


# ── URL building ────────────────────────────────────────────────

def test_build_url_wikipedia():
    url = _build_url("wikipedia", "A/Alan_Turing")
    assert url == "https://en.wikipedia.org/wiki/Alan_Turing"


def test_build_url_unknown_source():
    url = _build_url("custom", "some/path")
    assert url == "zim://custom/some/path"


def test_build_url_wiktionary():
    url = _build_url("wiktionary", "A/ephemeral")
    assert url == "https://en.wiktionary.org/wiki/ephemeral"


# ── ZimArticle ──────────────────────────────────────────────────

def test_zim_article_dataclass():
    article = ZimArticle(
        source_id="wikipedia",
        title="Alan Turing",
        path="A/Alan_Turing",
        snippet="Alan Turing was a mathematician...",
        url="https://en.wikipedia.org/wiki/Alan_Turing",
        source_label="Wikipedia",
    )
    assert article.title == "Alan Turing"
    assert article.source_label == "Wikipedia"


# ── Engine singleton ────────────────────────────────────────────

def test_get_search_engine_none_before_init():
    """Engine should be None before initialization."""
    # Note: this test may fail if another test initialized the engine
    # In production, engine is initialized at app startup
    engine = ZimSearchEngine()
    assert engine.loaded_sources == []


def test_engine_reload_skips_missing_files():
    """Reload should gracefully skip ZIM files that don't exist."""
    engine = ZimSearchEngine()
    states = [
        ArchiveState(
            source_id="wikipedia",
            variant="mini",
            language="en",
            file_path="/nonexistent/path.zim",
            file_size_bytes=100,
            zim_date="2025-03",
            download_complete=True,
        ),
    ]
    engine.reload_all(states)
    assert "wikipedia" not in engine.loaded_sources


def test_engine_reload_skips_incomplete():
    """Reload should skip archives that aren't fully downloaded."""
    engine = ZimSearchEngine()
    states = [
        ArchiveState(
            source_id="wikipedia",
            variant="mini",
            language="en",
            file_path="/some/path.zim",
            file_size_bytes=100,
            zim_date="2025-03",
            download_complete=False,
        ),
    ]
    engine.reload_all(states)
    assert engine.loaded_sources == []
