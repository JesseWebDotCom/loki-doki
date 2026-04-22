"""Tests for Wikipedia HTML section parsing."""
from __future__ import annotations

from pathlib import Path

from lokidoki.skills.knowledge._parse import (
    SECTION_PARAGRAPH_CHAR_CAP,
    WikiSection,
    is_disambiguation_page,
    salvage_disambiguation_lead,
    parse_wiki_html,
)


_FIXTURE = (
    Path(__file__).resolve().parents[1] / "fixtures" / "wiki" / "luke_skywalker.html"
)


def test_parse_wiki_html_captures_section_opening_paragraphs() -> None:
    html = """
    <div id="mw-content-text">
      <p>Luke Skywalker is a Jedi Knight from Tatooine.</p>
      <h2><span class="mw-headline">Early life</span></h2>
      <p>Luke grew up on his uncle's moisture farm.</p>
      <p>This second paragraph should not be captured.</p>
      <h2><span class="mw-headline">Galactic Civil War</span></h2>
      <div class="hatnote"><p>Hatnote text should be skipped.</p></div>
      <p>Luke joins the Rebel Alliance and destroys the Death Star.</p>
      <table><tr><td>Skip this table text.</td></tr></table>
    </div>
    """

    lead, sections = parse_wiki_html(html)

    assert lead == "Luke Skywalker is a Jedi Knight from Tatooine."
    assert sections == [
        WikiSection("Early life", "Luke grew up on his uncle's moisture farm."),
        WikiSection(
            "Galactic Civil War",
            "Luke joins the Rebel Alliance and destroys the Death Star.",
        ),
    ]


def test_parse_wiki_html_without_h2_returns_only_lead() -> None:
    html = """
    <div id="mw-content-text">
      <p>Leia Organa is a princess of Alderaan and a leader in the Rebel Alliance.</p>
      <p>She is also a skilled diplomat and commander.</p>
    </div>
    """

    lead, sections = parse_wiki_html(html)

    assert "Leia Organa is a princess of Alderaan" in lead
    assert "She is also a skilled diplomat and commander." in lead
    assert sections == []


def test_parse_wiki_html_filters_sections_without_opening_paragraph() -> None:
    html = """
    <div id="mw-content-text">
      <p>Anakin Skywalker is a Jedi Knight.</p>
      <h2><span class="mw-headline">Contents</span></h2>
      <h2><span class="mw-headline">Career</span></h2>
      <table><tr><td>No paragraph here.</td></tr></table>
      <h2><span class="mw-headline">Legacy</span></h2>
      <p>Anakin leaves behind a complicated legacy.</p>
    </div>
    """

    _, sections = parse_wiki_html(html)

    assert sections == [WikiSection("Legacy", "Anakin leaves behind a complicated legacy.")]


def test_parse_wiki_html_soft_cuts_section_paragraphs() -> None:
    long_sentence = " ".join(["Padme Amidala serves Naboo with careful diplomacy."] * 20)
    html = f"""
    <div id="mw-content-text">
      <p>Padme Amidala is a senator from Naboo.</p>
      <h2><span class="mw-headline">Public service</span></h2>
      <p>{long_sentence}</p>
    </div>
    """

    _, sections = parse_wiki_html(html)

    assert len(sections) == 1
    assert len(sections[0].paragraph) <= SECTION_PARAGRAPH_CHAR_CAP
    assert sections[0].paragraph.endswith((".", "!", "?"))


def test_parse_wiki_html_fixture_keeps_real_sections() -> None:
    html = _FIXTURE.read_text(encoding="utf-8")

    lead, sections = parse_wiki_html(html)

    assert "Luke Skywalker is a Jedi Knight from Tatooine" in lead
    titles = [section.title for section in sections]
    assert titles == [
        "Early life",
        "Galactic Civil War",
        "Jedi training",
        "Legacy",
        "See also",
        "References",
    ]


def test_is_disambiguation_page_detects_may_also_refer_to_lead() -> None:
    lead = (
        "Divine intervention is an event that occurs when a deity becomes actively "
        "involved in changing some situation in human affairs.\n\n"
        "Divine Intervention may also refer to:"
    )

    assert is_disambiguation_page(title="Divine Intervention", lead=lead) is True


def test_is_disambiguation_page_detects_explicit_disambiguation_notice() -> None:
    lead = (
        "This disambiguation page lists articles associated with the title Divine Intervention."
    )

    assert is_disambiguation_page(title="Divine Intervention", lead=lead) is True


def test_is_disambiguation_page_keeps_normal_article() -> None:
    lead = "Luke Skywalker is a Jedi Knight from Tatooine."

    assert is_disambiguation_page(title="Luke Skywalker", lead=lead) is False


def test_salvage_disambiguation_lead_keeps_useful_intro() -> None:
    lead = (
        "Divine intervention is an event that occurs when a deity becomes actively "
        "involved in changing some situation in human affairs.\n\n"
        "Divine Intervention may also refer to:"
    )

    assert salvage_disambiguation_lead(lead) == (
        "Divine intervention is an event that occurs when a deity becomes actively "
        "involved in changing some situation in human affairs."
    )
