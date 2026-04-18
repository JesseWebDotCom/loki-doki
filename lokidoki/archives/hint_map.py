"""Map decomposer ``archive_hint`` and ``capability_need`` to ZIM source IDs.

Keeps scoping logic out of the knowledge skill so every caller (skill,
search API, admin tooling) can derive the same source subset from the
decomposer's output.
"""
from __future__ import annotations

# Primary target per archive hint. Listed in relevance order so the
# first loaded archive wins when multiple are available.
# Only real Kiwix sources appear here — non-existent archives (wikiHow,
# MedlinePlus) have been dropped; medical routes to MDWiki instead.
HINT_TO_SOURCES: dict[str, tuple[str, ...]] = {
    "mdwiki": ("mdwiki", "wikem"),
    "wikem": ("wikem", "mdwiki"),
    "wikihow": ("ifixit", "appropedia", "wikibooks"),  # wikiHow not on Kiwix
    "ifixit": ("ifixit", "appropedia", "stackexchange"),
    "appropedia": ("appropedia", "ifixit", "wikibooks"),
    "khan": ("khanacademy", "wikibooks", "wikipedia"),
    "khanacademy": ("khanacademy", "freecodecamp", "wikibooks", "wikipedia"),
    "freecodecamp": ("freecodecamp", "khanacademy", "stackexchange"),
    "vikidia": ("vikidia", "wikipedia"),
    "factbook": ("factbook", "wikipedia"),
    "archwiki": ("archlinux", "stackexchange"),
    "archlinux": ("archlinux", "stackexchange", "python_docs"),
    "python_docs": ("python_docs", "stackexchange"),
    "wikivoyage": ("wikivoyage", "wikipedia"),
    "osm": ("openstreetmap_wiki", "wikivoyage", "wikipedia"),
    "gutenberg": ("gutenberg",),
    "wikipedia": ("wikipedia", "wiktionary", "wikiquote"),
    "stackexchange": ("stackexchange", "wikipedia"),
    "ted": ("ted_agriculture", "ted_ai"),
    "sustainability": ("appropedia", "stackexchange"),
}

# Fallback when no archive_hint but capability_need implies a category.
NEED_TO_SOURCES: dict[str, tuple[str, ...]] = {
    "medical": ("mdwiki", "wikem"),
    "howto": ("ifixit", "appropedia", "wikibooks"),
    "country_facts": ("factbook", "wikipedia"),
    "education": ("khanacademy", "freecodecamp", "wikibooks", "wikipedia"),
    "technical_reference": ("archlinux", "python_docs", "stackexchange", "wikipedia"),
    "geographic": ("wikivoyage", "openstreetmap_wiki", "wikipedia"),
    "encyclopedic": ("wikipedia", "wiktionary", "wikiquote"),
}


def sources_for_hint(archive_hint: str, capability_need: str = "") -> tuple[str, ...]:
    """Return the ordered list of ZIM source_ids the search should scope to.

    Precedence:
    1. Explicit ``archive_hint`` — the decomposer's targeted source.
    2. ``capability_need`` — the category fallback when hint is absent.
    3. Empty tuple — caller should search ALL loaded archives.
    """
    hint = (archive_hint or "").strip().lower()
    if hint and hint in HINT_TO_SOURCES:
        return HINT_TO_SOURCES[hint]
    need = (capability_need or "").strip().lower()
    if need and need in NEED_TO_SOURCES:
        return NEED_TO_SOURCES[need]
    return ()


def filter_to_loaded(
    source_ids: tuple[str, ...],
    loaded: list[str] | tuple[str, ...],
) -> list[str]:
    """Keep only source_ids that are actually loaded in the search engine.

    Empty result means the user has none of the hinted archives — the
    caller should fall back to searching all loaded sources rather than
    returning zero hits.
    """
    loaded_set = set(loaded)
    return [sid for sid in source_ids if sid in loaded_set]
