"""Closed-class English words used by the v2 orchestrator.

Each set is intentionally small and stable. Closed word classes (pronouns,
auxiliaries, determiners, conjunctions, wh-words, subordinators) almost never
gain new members in modern English, so a literal frozenset is a perfectly
mature representation: it is O(1) to query, trivially testable, and easier
to reason about than a model lookup.

Open-class words (nouns, adjectives, named entities) must NEVER live here —
those should always come from the spaCy ``Doc`` (POS tags, NER, noun chunks).
"""
from __future__ import annotations

# ---- closed word classes ----------------------------------------------------

#: English pronouns the resolver should treat as referents.
PRONOUNS: frozenset[str] = frozenset({
    "i", "me", "my", "mine", "myself",
    "you", "your", "yours", "yourself", "yourselves",
    "he", "him", "his", "himself",
    "she", "her", "hers", "herself",
    "it", "its", "itself",
    "we", "us", "our", "ours", "ourselves",
    "they", "them", "their", "theirs", "themselves",
    "this", "that", "these", "those",
})

#: Determiners that mark a noun phrase as a definite referent.
DETERMINERS: frozenset[str] = frozenset({
    "the", "this", "that", "these", "those",
    "my", "your", "his", "her", "its", "our", "their",
})

#: Wh-words that signal a question (and therefore an independent speech act).
WH_WORDS: frozenset[str] = frozenset({
    "what", "when", "where", "how", "why", "who", "whom", "whose", "which",
})

#: Subordinating conjunctions — when present, the trailing clause is
#: ``supporting_context`` rather than a request to route.
SUBORDINATORS: frozenset[str] = frozenset({
    "because", "since", "although", "though",
    "if", "unless", "while", "whereas",
    "when", "before", "after", "until",
    "so",
})

#: Coordinating + subordinating words that disqualify a fast-lane match
#: because they imply a compound or contextual utterance.
CONNECTORS: tuple[str, ...] = (
    " because ", " and ", " or ",
    " if ", " so that ", " but ", " also ", " then ", " while ",
)

#: Short interjections / acknowledgments treated as standalone speech acts.
INTERJECTIONS: frozenset[str] = frozenset({
    "hello", "hi", "hey", "yo", "ok", "okay",
    "thanks", "thank you", "thx", "ty",
    "sure", "yes", "no", "nope", "yep",
})

#: Finite auxiliary + copula forms used as a cheap "this clause has a
#: predicate" check in the splitter.
FINITE_AUX: frozenset[str] = frozenset({
    "is", "are", "was", "were", "am", "be", "been", "being",
    "do", "does", "did", "done",
    "have", "has", "had",
    "can", "could", "should", "would", "will", "may", "might", "must", "shall",
    "isnt", "arent", "wasnt", "werent",
    "dont", "doesnt", "didnt",
    "havent", "hasnt", "hadnt",
    "cant", "couldnt", "shouldnt", "wouldnt", "wont", "mustnt",
})


# ---- math word forms (used by the fast-lane math handler) -------------------

NUMBER_WORDS: dict[str, int] = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90, "hundred": 100, "thousand": 1000,
}

WORD_OPERATORS: dict[str, str] = {
    "plus": "+",
    "minus": "-",
    "times": "*",
    "multiplied": "*",
    "divided": "/",
    "over": "/",
    "x": "*",
    "by": "",
    "and": "+",
}
