"""ZIM search engine — queries installed archives via python-libzim.

The engine is initialized at app startup and reloaded when archive
config changes. Search runs in a thread pool since libzim is
synchronous. Results are returned as ZimArticle objects with
HTML-stripped snippets suitable for LLM consumption.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path

from .html_strip import strip_html, trim_to_sentences
from .models import ArchiveState

log = logging.getLogger(__name__)

# Canonical URL templates for reconstructing public URLs from ZIM paths
_URL_TEMPLATES: dict[str, str] = {
    "wikipedia": "https://en.wikipedia.org/wiki/{path}",
    "wiktionary": "https://en.wiktionary.org/wiki/{path}",
    "wikibooks": "https://en.wikibooks.org/wiki/{path}",
    "wikisource": "https://en.wikisource.org/wiki/{path}",
    "wikiquote": "https://en.wikiquote.org/wiki/{path}",
    "wikivoyage": "https://en.wikivoyage.org/wiki/{path}",
    "stackexchange": "https://stackexchange.com/search?q={path}",
    "ifixit": "https://www.ifixit.com/{path}",
    "gutenberg": "https://www.gutenberg.org/ebooks/{path}",
}

SNIPPET_CHARS = 1500


@dataclass
class ZimArticle:
    """A search result from a ZIM archive."""

    source_id: str
    title: str
    path: str
    snippet: str        # HTML-stripped, sentence-trimmed
    url: str            # reconstructed canonical URL
    source_label: str   # e.g. "Wikipedia"


class ZimSearchEngine:
    """Queries installed ZIM archives for articles."""

    def __init__(self) -> None:
        self._readers: dict[str, object] = {}   # source_id -> libzim.reader.Archive
        self._labels: dict[str, str] = {}       # source_id -> display label

    def load_archive(self, source_id: str, file_path: Path, label: str = "") -> None:
        """Open a ZIM file for searching."""
        try:
            from libzim.reader import Archive  # type: ignore[import-untyped]

            reader = Archive(str(file_path))
            self._readers[source_id] = reader
            self._labels[source_id] = label or source_id
            log.info("Loaded ZIM archive: %s (%s)", source_id, file_path)
        except Exception:
            log.exception("Failed to load ZIM archive: %s", source_id)

    def unload_archive(self, source_id: str) -> None:
        """Close and remove a ZIM archive."""
        self._readers.pop(source_id, None)
        self._labels.pop(source_id, None)

    def reload_all(self, states: list[ArchiveState]) -> None:
        """Reload all archives from persisted state."""
        from .catalog import get_source

        self._readers.clear()
        self._labels.clear()
        for state in states:
            if state.download_complete:
                p = Path(state.file_path)
                if p.exists():
                    source = get_source(state.source_id)
                    label = source.label if source else state.source_id
                    self.load_archive(state.source_id, p, label)

    @property
    def loaded_sources(self) -> list[str]:
        return list(self._readers.keys())

    async def search(
        self,
        query: str,
        sources: list[str] | None = None,
        max_results: int = 3,
    ) -> list[ZimArticle]:
        """Search across loaded ZIM archives. Runs in a thread pool."""
        return await asyncio.to_thread(
            self._search_sync, query, sources, max_results,
        )

    def _search_sync(
        self,
        query: str,
        sources: list[str] | None,
        max_results: int,
    ) -> list[ZimArticle]:
        """Synchronous search implementation."""
        results: list[ZimArticle] = []
        targets = sources or list(self._readers.keys())

        for source_id in targets:
            reader = self._readers.get(source_id)
            if reader is None:
                continue
            try:
                source_results = self._search_one(source_id, reader, query, max_results)
                results.extend(source_results)
            except Exception:
                log.exception("Search failed for source %s", source_id)

        # Sort by relevance (libzim search returns in relevance order per
        # source; interleave by keeping the per-source ordering)
        return results[:max_results]

    def _search_one(
        self,
        source_id: str,
        reader: object,
        query: str,
        max_results: int,
    ) -> list[ZimArticle]:
        """Search a single ZIM archive.

        Combines title suggestions (prefix match — handles partial
        typing like "alan tur" → "Alan Turing") with full-text search
        (matches content). Suggestions come first since a title match
        on partial input is almost always what the user wants.
        """
        from libzim.search import Query, Searcher  # type: ignore[import-untyped]
        from libzim.suggestion import SuggestionSearcher  # type: ignore[import-untyped]

        ordered_paths: list[str] = []
        articles: list[ZimArticle] = []

        # 1) Title suggestions (prefix match)
        try:
            suggester = SuggestionSearcher(reader)
            suggestions = suggester.suggest(query)
            for path in suggestions.getResults(0, max_results):
                if path not in ordered_paths:
                    ordered_paths.append(path)
        except Exception:
            pass

        # 2) Full-text search (content match)
        try:
            searcher = Searcher(reader)
            q = Query().set_query(query)
            search = searcher.search(q)
            for path in search.getResults(0, max_results * 2):
                if path not in ordered_paths:
                    ordered_paths.append(path)
        except Exception:
            pass

        # Build articles from the merged paths
        for path in ordered_paths[:max_results]:
            try:
                entry = reader.get_entry_by_path(path)
                item = entry.get_item()
                title = entry.title
                content_bytes = bytes(item.content)
                html = content_bytes.decode("utf-8", errors="replace")

                raw_text = strip_html(html, max_chars=SNIPPET_CHARS * 2)
                snippet = trim_to_sentences(raw_text, SNIPPET_CHARS)

                url = _build_url(source_id, path)
                label = self._labels.get(source_id, source_id)

                articles.append(ZimArticle(
                    source_id=source_id,
                    title=title,
                    path=path,
                    snippet=snippet,
                    url=url,
                    source_label=label,
                ))
            except Exception:
                log.debug("Failed to read entry %s from %s", path, source_id)
                continue

        return articles

    async def get_article(self, source_id: str, path: str) -> ZimArticle | None:
        """Fetch a single article by path. Returns None if not found."""
        return await asyncio.to_thread(self._get_article_sync, source_id, path)

    def _get_article_sync(self, source_id: str, path: str) -> ZimArticle | None:
        reader = self._readers.get(source_id)
        if reader is None:
            return None
        try:
            entry = reader.get_entry_by_path(path)
            item = entry.get_item()
            title = entry.title
            content_bytes = bytes(item.content)
            html = content_bytes.decode("utf-8", errors="replace")
            raw_text = strip_html(html)
            snippet = trim_to_sentences(raw_text, SNIPPET_CHARS)
            url = _build_url(source_id, path)
            label = self._labels.get(source_id, source_id)
            return ZimArticle(
                source_id=source_id,
                title=title,
                path=path,
                snippet=snippet,
                url=url,
                source_label=label,
            )
        except Exception:
            log.debug("Article not found: %s/%s", source_id, path)
            return None

    async def get_article_html(self, source_id: str, path: str) -> str | None:
        """Fetch raw HTML for an article. Used by the article browser."""
        return await asyncio.to_thread(self._get_html_sync, source_id, path)

    def _get_html_sync(self, source_id: str, path: str) -> str | None:
        reader = self._readers.get(source_id)
        if reader is None:
            return None
        try:
            entry = reader.get_entry_by_path(path)
            item = entry.get_item()
            return bytes(item.content).decode("utf-8", errors="replace")
        except Exception:
            return None

    async def get_media(self, source_id: str, path: str) -> bytes | None:
        """Fetch binary content (image, etc.) from a ZIM archive."""
        return await asyncio.to_thread(self._get_media_sync, source_id, path)

    def _get_media_sync(self, source_id: str, path: str) -> bytes | None:
        reader = self._readers.get(source_id)
        if reader is None:
            return None
        try:
            entry = reader.get_entry_by_path(path)
            item = entry.get_item()
            return bytes(item.content)
        except Exception:
            return None


def _build_url(source_id: str, path: str) -> str:
    """Reconstruct a canonical URL from a ZIM path."""
    template = _URL_TEMPLATES.get(source_id, "")
    if template:
        # Strip leading namespace prefixes (e.g., "A/" for articles)
        clean_path = path
        if len(path) > 2 and path[1] == "/":
            clean_path = path[2:]
        return template.format(path=clean_path)
    return f"zim://{source_id}/{path}"


# ── Module-level singleton ──────────────────────────────────────

_engine: ZimSearchEngine | None = None


def get_search_engine() -> ZimSearchEngine | None:
    """Return the singleton search engine.

    Lazy-initializes from persisted state if the engine is None or has
    no loaded sources — this handles the case where archives are
    downloaded after app startup.
    """
    global _engine
    if _engine is None or not _engine.loaded_sources:
        from .store import load_states
        states = load_states()
        ready = [s for s in states if s.download_complete]
        if ready:
            _engine = ZimSearchEngine()
            _engine.reload_all(ready)
        elif _engine is None:
            return None
    return _engine


def reload_search_engine() -> None:
    """Force-reload the search engine from current persisted state.

    Called after a download completes or archive config changes.
    """
    global _engine
    from .store import load_states
    states = load_states()
    ready = [s for s in states if s.download_complete]
    if ready:
        _engine = ZimSearchEngine()
        _engine.reload_all(ready)
    else:
        _engine = None


def initialize_search_engine(states: list[ArchiveState]) -> ZimSearchEngine:
    """Create and populate the singleton search engine."""
    global _engine
    _engine = ZimSearchEngine()
    _engine.reload_all(states)
    return _engine
