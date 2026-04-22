"""Wikipedia HTML parsing and relevance-checking helpers.

Extracted from skill.py to keep both files under 300 lines.
"""
from __future__ import annotations

from dataclasses import dataclass
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
SECTION_PARAGRAPH_CHAR_CAP = 600

# Junk title patterns we never want to surface as the canonical answer.
_JUNK_TITLE_PREFIXES = ("list of ", "lists of ", "category:", "portal:", "template:", "wikipedia:")
_JUNK_TITLE_SUBSTRINGS = ("(disambiguation)", "(disambiguation page)")
_DISAMBIGUATION_LEAD_MARKERS = (
    "may also refer to:",
    "may refer to:",
    "this disambiguation page lists articles associated with the title",
)

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


def _title_substantially_matches(title: str, query: str) -> bool:
    """Stricter relevance gate for person / proper-noun style queries.

    Require ``min(n, 2)`` significant tokens to overlap between title
    and query. A 1-token query needs that token in the title; every
    query with 2+ significant tokens needs at least two of them to
    appear. That rejects "Amanda Palmer" for "who is palmer rocky"
    (1 overlap < 2) and "Palmer Island Light Station" for the same
    (1 overlap), while still accepting "Corey Feldman" for "who is
    corey feldman" (2/2) and "Dune (novel)" for "summary of the dune
    novel by frank herbert" (2 overlap on dune+novel).

    When the query has no significant tokens (every word is too short
    or a stopword — e.g. "cpr"), fall back to substring containment on
    words of 3+ characters so the title has to literally mention the
    ask.
    """
    q_tokens = _query_tokens(query)
    if q_tokens:
        t_tokens = _query_tokens(title)
        overlap = len(q_tokens & t_tokens)
        required = min(len(q_tokens), 2)
        return overlap >= required
    lt = title.lower()
    return any(w.lower() in lt for w in query.split() if len(w) >= 3)


def _is_junk_title(title: str) -> bool:
    low = (title or "").lower()
    if not low:
        return True
    if any(low.startswith(p) for p in _JUNK_TITLE_PREFIXES):
        return True
    if any(s in low for s in _JUNK_TITLE_SUBSTRINGS):
        return True
    return False


def is_disambiguation_page(title: str, lead: str) -> bool:
    """Return True when the resolved article is a disambiguation page.

    Wikipedia disambiguation pages are often plain titles like
    ``Divine Intervention`` rather than ``Foo (disambiguation)``, so a
    title-only filter is insufficient. Detect the common lead markers as
    a second line of defense.
    """
    if _is_junk_title(title):
        return True
    normalized = " ".join((lead or "").lower().split())
    return any(marker in normalized for marker in _DISAMBIGUATION_LEAD_MARKERS)


def salvage_disambiguation_lead(lead: str) -> str:
    """Keep the useful definitional intro from a disambiguation lead.

    Example:
    ``"Divine intervention is ... Divine Intervention may also refer to:"``
    becomes just the first sentence / paragraph.
    """
    text = (lead or "").strip()
    if not text:
        return ""
    paragraphs = [part.strip() for part in text.split("\n\n") if part.strip()]
    if len(paragraphs) > 1:
        tail = paragraphs[-1].lower()
        if any(marker in tail for marker in _DISAMBIGUATION_LEAD_MARKERS):
            return "\n\n".join(paragraphs[:-1]).strip()
    lower = text.lower()
    for marker in _DISAMBIGUATION_LEAD_MARKERS:
        idx = lower.find(marker)
        if idx != -1:
            prefix = text[:idx].strip()
            prefix = prefix.rstrip(":;,- \n")
            return prefix
    return text


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


@dataclass(frozen=True)
class WikiSection:
    """Structured top-level Wikipedia section summary."""

    title: str
    paragraph: str


class _LeadExtractor(HTMLParser):
    """Pull the lead <p> paragraphs and top-level <h2> section summaries.

    Wikipedia's article body lives in <div id="mw-content-text">. The lead
    is every <p> before the first <h2>.
    """

    def __init__(self) -> None:
        super().__init__()
        self._in_content = False
        self._content_depth = 0
        self._in_p = False
        self._in_section_p = False
        self._in_h2 = False
        self._in_headline = False
        self._seen_first_h2 = False
        self._skip_depth = 0
        self._lead_buf: list[str] = []
        self._cur_p: list[str] = []
        self._cur_section: list[str] = []
        self._cur_section_p: list[str] = []
        self._current_section_title: str | None = None
        self._section_paragraph_captured = False
        self.lead_paragraphs: list[str] = []
        self.sections: list[str] = []
        self.section_items: list[WikiSection] = []

    def _flush_section(self) -> None:
        title = (self._current_section_title or "").strip()
        paragraph = _trim_to_sentences("".join(self._cur_section_p).strip(), SECTION_PARAGRAPH_CHAR_CAP)
        if title and paragraph:
            self.section_items.append(WikiSection(title=title, paragraph=paragraph))
        self._current_section_title = None
        self._cur_section_p = []
        self._section_paragraph_captured = False

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
            if "hatnote" in (attrs_d.get("class") or ""):
                self._skip_depth += 1
                return
        if tag in ("sup", "style", "script", "table"):
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "p" and not self._seen_first_h2:
            self._in_p = True
            self._cur_p = []
        elif (
            tag == "p"
            and self._seen_first_h2
            and self._current_section_title is not None
            and not self._section_paragraph_captured
        ):
            self._in_section_p = True
            self._cur_section_p = []
        elif tag == "h2":
            self._flush_section()
            self._in_h2 = True
            self._cur_section = []
            self._current_section_title = None
            self._cur_section_p = []
            self._section_paragraph_captured = False
        elif self._in_h2 and tag == "span":
            cls = attrs_d.get("class", "")
            if "mw-headline" in cls:
                self._in_headline = True

    def handle_endtag(self, tag: str):
        if not self._in_content:
            return
        if tag in ("sup", "style", "script", "table", "div"):
            if self._skip_depth:
                self._skip_depth -= 1
                if tag == "div":
                    self._content_depth -= 1
                    if self._content_depth <= 0:
                        self._in_content = False
                return
        if self._skip_depth:
            return
        if tag == "p" and self._in_p:
            text = "".join(self._cur_p).strip()
            if text:
                self.lead_paragraphs.append(text)
            self._in_p = False
        elif tag == "p" and self._in_section_p:
            text = "".join(self._cur_section_p).strip()
            if text:
                self._cur_section_p = [text]
                self._section_paragraph_captured = True
            self._in_section_p = False
        elif tag == "span" and self._in_headline:
            self._in_headline = False
        elif tag == "h2" and self._in_h2:
            title = "".join(self._cur_section).strip()
            if title and title.lower() not in ("contents",):
                self.sections.append(title)
                self._current_section_title = title
            self._in_h2 = False
            self._seen_first_h2 = True
        elif tag == "div":
            self._content_depth -= 1
            if self._content_depth <= 0:
                self._flush_section()
                self._in_content = False

    def handle_data(self, data: str):
        if not self._in_content or self._skip_depth:
            return
        if self._in_p:
            self._cur_p.append(data)
        elif self._in_section_p:
            self._cur_section_p.append(data)
        elif self._in_headline:
            self._cur_section.append(data)


def parse_wiki_html(html: str) -> tuple[str, list[WikiSection]]:
    parser = _LeadExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    parser._flush_section()
    lead = unescape("\n\n".join(parser.lead_paragraphs)).strip()
    if len(lead) > LEAD_CHAR_CAP:
        lead = lead[:LEAD_CHAR_CAP].rsplit(" ", 1)[0] + "\u2026"
    return lead, parser.section_items


# ZIM Wikipedia articles reference images via relative paths like
# ``../I/m/Foo.jpg`` or ``I/m/Foo.jpg``. The ZIM asset HTTP route
# (``/api/v1/archives/media/{source_id}/{path}``) expects the path
# WITHOUT a leading ``../`` or ``./``. Small icons (flags, separators,
# edit-pencil glyphs) live under ``I/s/`` or as data-URIs; we keep
# only the larger image namespace ``I/m/`` plus bare-leaf ``I/`` paths.
_REL_PREFIX = ("../", "./")
_DATA_URI_PREFIXES = ("data:", "javascript:")


class _ImageExtractor(HTMLParser):
    """Collect ``<img src>`` paths in document order.

    Skips tiny/icon images (explicit width or height below
    :data:`_MIN_IMAGE_DIMENSION` on the tag) and anything inside an
    infobox-adjacent skip region. Wikipedia's infobox portraits DO
    live inside ``class="infobox"`` — we want those — so the skip list
    here is narrower than :class:`_LeadExtractor`; just nav boxes,
    edit links, and explicit hidden wrappers.
    """

    _SKIP_CLASSES = frozenset({
        "navbox", "metadata", "mw-editsection", "noprint", "sistersitebox",
    })

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._skip_tags_stack: list[str] = []
        self.images: list[dict[str, str | int]] = []

    def _should_skip(self, attrs: list[tuple[str, str | None]]) -> bool:
        cls = dict(attrs).get("class") or ""
        return any(marker in cls for marker in self._SKIP_CLASSES)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_d = dict(attrs)
        if tag == "div" and self._should_skip(attrs):
            self._skip_depth += 1
            self._skip_tags_stack.append(tag)
            return
        if self._skip_depth:
            return
        if tag != "img":
            return
        src = (attrs_d.get("src") or "").strip()
        if not src or any(src.startswith(p) for p in _DATA_URI_PREFIXES):
            return
        # Strip ``./`` and ``../`` prefixes — the ZIM asset endpoint
        # takes a flat path.
        while True:
            stripped = False
            for prefix in _REL_PREFIX:
                if src.startswith(prefix):
                    src = src[len(prefix):]
                    stripped = True
                    break
            if not stripped:
                break
        width = _int_attr(attrs_d.get("width"))
        height = _int_attr(attrs_d.get("height"))
        if width and width < _MIN_IMAGE_DIMENSION:
            return
        if height and height < _MIN_IMAGE_DIMENSION:
            return
        self.images.append({
            "src": src,
            "alt": (attrs_d.get("alt") or "").strip(),
            "width": width or 0,
            "height": height or 0,
        })

    def handle_endtag(self, tag: str) -> None:
        if self._skip_depth and self._skip_tags_stack and self._skip_tags_stack[-1] == tag:
            self._skip_tags_stack.pop()
            self._skip_depth -= 1


# Minimum width/height a ZIM ``<img>`` must declare to be treated as
# real article content. Anything smaller is almost always a decorative
# icon (flag, external-link arrow, edit-pencil glyph).
_MIN_IMAGE_DIMENSION = 80


def _int_attr(value: str | None) -> int:
    if not value:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def parse_wiki_images(html: str, *, limit: int = 3) -> list[dict[str, str | int]]:
    """Extract up to ``limit`` content images from ZIM Wikipedia HTML.

    Returns a list of dicts with ``src`` (flat path, no ``../``),
    ``alt``, ``width``, ``height``. Paths are ZIM-relative and must be
    composed with the source id before they resolve via the archive
    media route.
    """
    parser = _ImageExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    seen: set[str] = set()
    out: list[dict[str, str | int]] = []
    for img in parser.images:
        src = str(img.get("src") or "")
        if not src or src in seen:
            continue
        seen.add(src)
        out.append(img)
        if len(out) >= limit:
            break
    return out
