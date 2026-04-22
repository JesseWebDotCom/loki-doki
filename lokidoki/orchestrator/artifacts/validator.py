"""Validation rules for rich-response artifacts.

This intentionally favors false positives over permissiveness: artifact
content must be self-contained, offline-safe, and unable to reach out
to the network or escape the sandbox.
"""
from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urlparse
import re

from lokidoki.orchestrator.artifacts.types import Artifact, ArtifactKind

MAX_ARTIFACT_BYTES = 256 * 1024

_URL_ATTRS = ("src", "href", "xlink:href", "poster", "action", "formaction")
_DISALLOWED_APIS = (
    "eval(",
    "new Function(",
    "fetch(",
    "XMLHttpRequest",
    "import(",
    "navigator.serviceWorker",
    "WebSocket(",
)
_TOP_NAVIGATION_PATTERNS = (
    "window.top",
    "top.location",
    "window.parent.location",
    "parent.location",
)
_CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)([^)\"']+)\1\s*\)", re.IGNORECASE)
_CSS_IMPORT_RE = re.compile(r"@import\s+(?:url\()?['\"]?([^'\"\)\s]+)", re.IGNORECASE)
_JS_IMPORT_RE = re.compile(r"\bimport\s+['\"]([^'\"]+)['\"]", re.IGNORECASE)


@dataclass(frozen=True)
class ArtifactValidationError(ValueError):
    """Structured validation failure."""

    rule: str
    detail: str

    def __str__(self) -> str:
        return f"{self.rule}: {self.detail}"


class _ReferenceScanner(HTMLParser):
    """Collect URL-bearing attributes and form usage from markup."""

    def __init__(self) -> None:
        super().__init__()
        self.references: list[tuple[str, str]] = []
        self.saw_form = False

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag.lower() == "form":
            self.saw_form = True
        for attr, value in attrs:
            if value is None:
                continue
            if attr.lower() in _URL_ATTRS:
                self.references.append((attr.lower(), value))


def _is_allowed_embedded_url(value: str) -> bool:
    candidate = value.strip()
    if not candidate:
        return True
    parsed = urlparse(candidate)
    if parsed.scheme in {"data", "blob"}:
        return True
    return False


def _raise(rule: str, detail: str) -> None:
    raise ArtifactValidationError(rule=rule, detail=detail)


def _validate_size(content: str) -> int:
    size_bytes = len(content.encode("utf-8"))
    if size_bytes > MAX_ARTIFACT_BYTES:
        _raise("size_cap", f"artifact is {size_bytes} bytes; cap is {MAX_ARTIFACT_BYTES}")
    return size_bytes


def _validate_references(content: str) -> None:
    scanner = _ReferenceScanner()
    scanner.feed(content)

    for attr, value in scanner.references:
        if not _is_allowed_embedded_url(value):
            _raise("remote_url", f"{attr} reference is not self-contained: {value!r}")

    for match in _CSS_URL_RE.finditer(content):
        value = match.group(2)
        if not _is_allowed_embedded_url(value):
            _raise("remote_url", f"css url() reference is not self-contained: {value!r}")

    for match in _CSS_IMPORT_RE.finditer(content):
        value = match.group(1)
        if not _is_allowed_embedded_url(value):
            _raise("remote_url", f"css @import is not self-contained: {value!r}")

    for match in _JS_IMPORT_RE.finditer(content):
        value = match.group(1)
        if not _is_allowed_embedded_url(value):
            _raise("remote_url", f"javascript import is not self-contained: {value!r}")

    if scanner.saw_form:
        _raise("forms", "forms are disabled in artifacts by default")


def _validate_disallowed_apis(content: str) -> None:
    for token in _DISALLOWED_APIS:
        if token in content:
            _raise("disallowed_api", f"found forbidden API token {token!r}")


def _validate_navigation(content: str) -> None:
    for token in _TOP_NAVIGATION_PATTERNS:
        if token in content:
            _raise("top_navigation", f"found top-level navigation token {token!r}")


def validate_artifact_content(
    *, kind: ArtifactKind, title: str, content: str
) -> int:
    """Validate raw artifact content and return its byte size."""

    del kind, title  # kept explicit for future policy exceptions
    size_bytes = _validate_size(content)
    _validate_references(content)
    _validate_disallowed_apis(content)
    _validate_navigation(content)
    return size_bytes


def validate_artifact(artifact: Artifact) -> None:
    """Validate every version of an artifact."""

    for version in artifact.versions:
        size_bytes = validate_artifact_content(
            kind=artifact.kind,
            title=artifact.title,
            content=version.content,
        )
        if size_bytes != version.size_bytes:
            _raise(
                "size_mismatch",
                f"version {version.version} size_bytes={version.size_bytes} != actual {size_bytes}",
            )

