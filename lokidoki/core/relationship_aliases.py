from __future__ import annotations

from copy import deepcopy


DEFAULT_RELATIONSHIP_ALIASES: dict[str, list[str]] = {
    "mother": ["mom", "mommy", "mama", "ma", "mother"],
    "father": ["dad", "daddy", "pops", "pa", "father"],
    "brother": ["bro", "brother", "brotha"],
    "sister": ["sis", "sister", "sissy"],
    "sister-in-law": ["sister in law", "sister-in-law"],
    "brother-in-law": ["brother in law", "brother-in-law"],
    "wife": ["wife", "wifey"],
    "husband": ["husband", "hubby"],
    "spouse": ["spouse", "partner"],
    "friend": ["friend", "best friend", "buddy"],
    "coworker": ["coworker", "co-worker", "colleague"],
}


def normalize_relationship_term(text: str) -> str:
    cleaned = " ".join(str(text or "").strip().lower().replace("’", "'").split())
    return cleaned.replace(" - ", "-").replace("- ", "-").replace(" -", "-")


def canonicalize_relationship_aliases(raw: object) -> dict[str, list[str]]:
    aliases = deepcopy(DEFAULT_RELATIONSHIP_ALIASES)
    if not isinstance(raw, dict):
        return aliases
    for canonical, values in raw.items():
        canonical_norm = normalize_relationship_term(canonical)
        if not canonical_norm:
            continue
        merged = {canonical_norm}
        if isinstance(values, list):
            for value in values:
                normalized = normalize_relationship_term(value)
                if normalized:
                    merged.add(normalized)
        aliases[canonical_norm] = sorted(merged)
    return aliases


def alias_to_canonical_map(
    aliases: dict[str, list[str]] | None = None,
) -> dict[str, str]:
    canonicalized = canonicalize_relationship_aliases(aliases or {})
    mapping: dict[str, str] = {}
    for canonical, values in canonicalized.items():
        mapping[canonical] = canonical
        for value in values:
            normalized = normalize_relationship_term(value)
            if normalized:
                mapping[normalized] = canonical
    return mapping
