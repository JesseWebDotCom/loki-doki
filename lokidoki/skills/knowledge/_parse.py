"""Wikipedia HTML parsing and relevance-checking helpers.

Extracted from skill.py to keep both files under 300 lines.
"""
from __future__ import annotations

from html import unescape
from html.parser import HTMLParser

# Absolute safety cap on lead length. Real Wikipedia leads are 500-3000
# chars; anything past 8k is almost certainly a parse failure.
LEAD_CHAR_CAP = 8000

# Soft cap for the verbatim path. The decomposer marks short factual
# lookups as response_shape=verbatim, which means the orchestrator emits
# our ``lead`` straight to the user with no synthesis filter. A full
# Wikipedia lead is 5+ paragraphs and reads as a wall of text in chat,
# so we trim to the first couple of sentences.
VERBATIM_LEAD_CHAR_CAP = 600

# Junk title patterns we never want to surface as the canonical answer.
_JUNK_TITLE_PREFIXES = ("list of ", "lists of ", "category:", "portal:", "template:", "wikipedia:")
_JUNK_TITLE_SUBSTRINGS = ("(disambiguation)", "(disambiguation page)")

# Stopwords excluded from the title-overlap relevance check.
_OVERLAP_STOPWORDS = frozenset({
    "what", "when", "where", "which", "while", "with", "from", "into",
    "that", "this", "they", "them", "their", "there", "about", "have",
    "does", "did", "tell", "give", "show", "know", "like", "want",
    "your", "yours", "mine", "ours", "some", "many", "much", "more",
    "most", "just", "also", "than", "then", "such", "very", "really",
    "really", "here", "thing", "stuff", "kind", "type",
})


def _strip_diacritics(text: str) -> str:
    """Fold Unicode diacritics so 'Queensryche' matches 'queensryche'."""
    import unicodedata
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def _query_tokens(query: str) -> set[str]:
    """Significant (4+ char, non-stopword) lowercase tokens for the
    title-overlap relevance check.

    Diacritics are stripped so 'Queensryche' and 'queensryche' match.
    """
    out: set[str] = set()
    cur: list[str] = []
    for ch in _strip_diacritics(query or "").lower():
        if ch.isalnum():
            cur.append(ch)
        else:
            if cur:
                tok = "".join(cur)
                if len(tok) >= 4 and tok not in _OVERLAP_STOPWORDS:
                    out.add(tok)
                cur = []
    if cur:
        tok = "".join(cur)
        if len(tok) >= 4 and tok not in _OVERLAP_STOPWORDS:
            out.add(tok)
    return out


def _title_matches_query(title: str, query: str) -> bool:
    """Cheap relevance gate. A resolved title is acceptable if it shares
    at least one significant token with the query, OR the query is so
    short/generic that no token survived filtering."""
    q_tokens = _query_tokens(query)
    if not q_tokens:
        return True
    t_tokens = _query_tokens(title)
    return bool(q_tokens & t_tokens)


def _is_junk_title(title: str) -> bool:
    low = (title or "").lower()
    if not low:
        return True
    if any(low.startswith(p) for p in _JUNK_TITLE_PREFIXES):
        return True
    if any(s in low for s in _JUNK_TITLE_SUBSTRINGS):
        return True
    return False


def _page_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"


def _trim_to_sentences(text: str, char_cap: int) -> str:
    """Return the first whole sentences of ``text`` within ``char_cap``.

    We never split mid-sentence -- better to under-fill the budget than
    leave the user with a dangling clause.
    """
    text = (text or "").strip()
    if len(text) <= char_cap:
        return text
    window = text[:char_cap]
    cut = -1
    for i in range(len(window) - 1, 0, -1):
        if window[i - 1] in ".!?" and (i == len(window) or window[i] == " "):
            cut = i
            break
    if cut > 0:
        return window[:cut].strip()
    return window.rsplit(" ", 1)[0] + "\u2026"


class _LeadExtractor(HTMLParser):
    """Pull the lead <p> paragraphs and top-level <h2> section titles.

    Wikipedia's article body lives in <div id="mw-content-text">. The lead
    is every <p> before the first <h2>.
    """

    def __init__(self) -> None:
        super().__init__()
        self._in_content = False
        self._content_depth = 0
        self._in_p = False
        self._in_h2 = False
        self._in_headline = False
        self._seen_first_h2 = False
        self._skip_depth = 0
        self._lead_buf: list[str] = []
        self._cur_p: list[str] = []
        self._cur_section: list[str] = []
        self.lead_paragraphs: list[str] = []
        self.sections: list[str] = []

    def handle_starttag(self, tag: str, attrs):
        attrs_d = dict(attrs)
        if tag == "div" and attrs_d.get("id") == "mw-content-text":
            self._in_content = True
            self._content_depth = 1
            return
        if not self._in_content:
            return
        if tag == "div":
            self._content_depth += 1
        if tag in ("sup", "style", "script", "table"):
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "p" and not self._seen_first_h2:
            self._in_p = True
            self._cur_p = []
        elif tag == "h2":
            self._in_h2 = True
            self._cur_section = []
        elif self._in_h2 and tag == "span":
            cls = attrs_d.get("class", "")
            if "mw-headline" in cls:
                self._in_headline = True

    def handle_endtag(self, tag: str):
        if not self._in_content:
            return
        if tag in ("sup", "style", "script", "table"):
            if self._skip_depth:
                self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag == "p" and self._in_p:
            text = "".join(self._cur_p).strip()
            if text:
                self.lead_paragraphs.append(text)
            self._in_p = False
        elif tag == "span" and self._in_headline:
            self._in_headline = False
        elif tag == "h2" and self._in_h2:
            title = "".join(self._cur_section).strip()
            if title and title.lower() not in ("contents",):
                self.sections.append(title)
            self._in_h2 = False
            self._seen_first_h2 = True
        elif tag == "div":
            self._content_depth -= 1
            if self._content_depth <= 0:
                self._in_content = False

    def handle_data(self, data: str):
        if not self._in_content or self._skip_depth:
            return
        if self._in_p:
            self._cur_p.append(data)
        elif self._in_headline:
            self._cur_section.append(data)


def parse_wiki_html(html: str) -> tuple[str, list[str]]:
    parser = _LeadExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    lead = unescape("\n\n".join(parser.lead_paragraphs)).strip()
    if len(lead) > LEAD_CHAR_CAP:
        lead = lead[:LEAD_CHAR_CAP].rsplit(" ", 1)[0] + "\u2026"
    return lead, parser.sections
