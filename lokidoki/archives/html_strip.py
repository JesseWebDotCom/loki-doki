"""Lightweight HTML-to-text converter using stdlib html.parser.

Strips tags, collapses whitespace, and trims to sentence boundaries.
Used by the search engine to produce clean snippets from ZIM articles,
and by the article browser to convert full articles to markdown.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser


class _TextExtractor(HTMLParser):
    """Extracts visible text from HTML, skipping non-body content.

    Skips script/style/nav and tracks class-based skip regions
    (Wikipedia infobox tables, sidebars, etc.) using a tag-depth stack
    so that endtags — which don't carry attrs — correctly decrement
    the skip counter.
    """

    _SKIP_TAGS = frozenset({"script", "style", "nav", "noscript", "svg", "math"})
    _SKIP_CLASSES = frozenset({
        "infobox", "sidebar", "navbox", "metadata", "mw-editsection",
        "hatnote", "shortdescription", "mbox-small", "ambox",
    })

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth = 0
        # Stack of tags that started a skip region, so we only
        # decrement on the matching endtag.
        self._skip_tags_stack: list[str] = []

    def _should_skip(self, tag: str, attrs: list[tuple[str, str | None]]) -> bool:
        if tag in self._SKIP_TAGS:
            return True
        cls = dict(attrs).get("class") or ""
        return any(sc in cls for sc in self._SKIP_CLASSES)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._should_skip(tag, attrs):
            self._skip_depth += 1
            self._skip_tags_stack.append(tag)
        elif tag in ("p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"):
            if self._skip_depth == 0:
                self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if self._skip_depth > 0 and self._skip_tags_stack and self._skip_tags_stack[-1] == tag:
            self._skip_tags_stack.pop()
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._parts.append(data)

    def get_text(self) -> str:
        return "".join(self._parts)


_MULTI_SPACE = re.compile(r"[ \t]+")
_MULTI_NEWLINE = re.compile(r"\n{3,}")


def strip_html(html: str, max_chars: int = 2000) -> str:
    """Strip HTML tags and return clean text, capped at max_chars."""
    extractor = _TextExtractor()
    try:
        extractor.feed(html)
    except Exception:
        # Malformed HTML — return what we got
        pass
    text = extractor.get_text()
    # Collapse all whitespace-only lines into single newlines
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    text = _MULTI_NEWLINE.sub("\n\n", text)
    text = _MULTI_SPACE.sub(" ", text)
    text = text.strip()
    if len(text) > max_chars:
        text = text[:max_chars]
    return text


_SENTENCE_END = re.compile(r"[.!?]\s")


def trim_to_sentences(text: str, max_chars: int) -> str:
    """Trim text to the last complete sentence within max_chars."""
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars]
    # Find the last sentence boundary
    matches = list(_SENTENCE_END.finditer(truncated))
    if matches:
        last = matches[-1]
        return truncated[: last.end()].rstrip()
    # No sentence boundary found — just truncate at last space
    last_space = truncated.rfind(" ")
    if last_space > max_chars // 2:
        return truncated[:last_space] + "\u2026"
    return truncated + "\u2026"
