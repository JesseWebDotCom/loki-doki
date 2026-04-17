"""Convert ZIM article HTML to clean markdown for theme-matched rendering.

Wiki HTML contains enormous amounts of chrome (infoboxes, navboxes,
edit links, hatnotes, metadata tables, reference lists). We strip
aggressively — the goal is clean readable prose, not a pixel-perfect
wiki replica. The output is consumed by the ProseRenderer component.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser


# Classes that indicate non-content wiki chrome
_SKIP_CLASSES = frozenset({
    "navbox", "sidebar", "mw-editsection", "hatnote", "noprint",
    "metadata", "ambox", "catlinks", "mw-jump-link", "mw-indicators",
    "toc", "infobox", "mw-references-wrap", "reflist", "reference",
    "mw-cite-backlink", "mw-empty-elt", "shortdescription",
    "mbox-small", "sistersitebox", "portalbox", "authority-control",
    "wikitable", "thumb",
})

# Tags that are never content
_SKIP_TAGS = frozenset({
    "script", "style", "noscript", "svg", "math", "figure",
})


class _MdConverter(HTMLParser):
    """Single-pass HTML→Markdown, aggressively skipping wiki chrome.

    Skip tracking uses a stack of (tag, depth) pairs rather than a
    single counter. This handles wiki HTML where tags are frequently
    misnested (e.g. ``<table>`` closed by ``</div>``).
    """

    def __init__(self) -> None:
        super().__init__()
        self._out: list[str] = []
        self._skip_stack: list[tuple[str, int]] = []  # (tag, nesting_depth)
        self._list = 0
        self._pre = False
        self._href: str | None = None

    def _skipping(self) -> bool:
        return len(self._skip_stack) > 0

    def _push_skip(self, tag: str) -> None:
        self._skip_stack.append((tag, 1))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # Inside a skip zone: track depth of the *same* tag so we know
        # when the matching close arrives.
        if self._skipping():
            stag, depth = self._skip_stack[-1]
            if tag == stag:
                self._skip_stack[-1] = (stag, depth + 1)
            return

        amap = dict(attrs)
        classes = set((amap.get("class") or "").split())

        if classes & _SKIP_CLASSES:
            self._push_skip(tag)
            return
        if tag in _SKIP_TAGS:
            self._push_skip(tag)
            return
        if tag == "table":
            self._push_skip("table")
            return
        # Skip the entire <head> and wiki header/footer
        if tag in ("head", "header", "footer", "nav"):
            self._push_skip(tag)
            return

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "p":
            self._out.append("\n\n")
        elif tag == "br":
            self._out.append("\n")
        elif tag in ("strong", "b"):
            self._out.append("**")
        elif tag in ("em", "i"):
            self._out.append("*")
        elif tag == "a":
            self._href = amap.get("href")
            self._out.append("[")
        elif tag in ("ul", "ol"):
            self._list += 1
            self._out.append("\n")
        elif tag == "li":
            indent = "  " * max(0, self._list - 1)
            self._out.append(f"\n{indent}- ")
        elif tag == "blockquote":
            self._out.append("\n\n> ")
        elif tag == "pre":
            self._pre = True
            self._out.append("\n\n```\n")
        elif tag == "code" and not self._pre:
            self._out.append("`")
        elif tag == "hr":
            self._out.append("\n\n---\n\n")

    def handle_endtag(self, tag: str) -> None:
        if self._skipping():
            stag, depth = self._skip_stack[-1]
            if tag == stag:
                if depth <= 1:
                    self._skip_stack.pop()
                else:
                    self._skip_stack[-1] = (stag, depth - 1)
            return

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._out.append("\n")
        elif tag in ("strong", "b"):
            self._out.append("**")
        elif tag in ("em", "i"):
            self._out.append("*")
        elif tag == "a":
            href = self._href or ""
            self._href = None
            if href and not href.startswith("#") and not href.startswith("javascript"):
                self._out.append(f"]({href})")
            else:
                self._out.append("]()")
        elif tag in ("ul", "ol"):
            self._list = max(0, self._list - 1)
            self._out.append("\n")
        elif tag == "pre":
            self._pre = False
            self._out.append("\n```\n\n")
        elif tag == "code" and not self._pre:
            self._out.append("`")

    def handle_data(self, data: str) -> None:
        if self._skipping():
            return
        if self._pre:
            self._out.append(data)
        else:
            self._out.append(re.sub(r"\s+", " ", data))

    def result(self) -> str:
        raw = "".join(self._out)
        raw = re.sub(r"[ \t]*\n[ \t]*", "\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        raw = re.sub(r"\*\*\s*\*\*", "", raw)
        raw = re.sub(r"\*\s*\*", "", raw)
        raw = re.sub(r"\[\s*\]\(\s*\)", "", raw)
        return raw.strip()


def html_to_markdown(html: str) -> str:
    """Convert HTML to clean markdown, stripping wiki chrome."""
    converter = _MdConverter()
    try:
        converter.feed(html)
    except Exception:
        pass
    return converter.result()


def extract_toc(markdown: str) -> list[dict[str, str]]:
    """Extract a table of contents from markdown headings."""
    toc: list[dict[str, str]] = []
    for match in re.finditer(r"^(#{1,4})\s+(.+)$", markdown, re.MULTILINE):
        level = len(match.group(1))
        title = match.group(2).strip()
        slug = re.sub(r"[^\w\s-]", "", title.lower()).replace(" ", "-")
        toc.append({"level": level, "title": title, "slug": slug})
    return toc
