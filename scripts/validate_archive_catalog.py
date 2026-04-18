"""Validate ZIM_CATALOG entries against the live Kiwix CDN.

For each source in ``lokidoki.archives.catalog.ZIM_CATALOG``, probe
``https://download.kiwix.org/zim/<kiwix_dir>/`` and confirm at least
one file matches each variant's ``url_slug``. Prints a green tick for
valid entries and a red cross + the CDN directory listing hint for
invalid ones.

Run before shipping new catalog additions::

    uv run python scripts/validate_archive_catalog.py

Exits nonzero if any entry has no matching file on the CDN, so this
can gate CI or a pre-release check.
"""
from __future__ import annotations

import re
import sys
from urllib.request import Request, urlopen

from lokidoki.archives.catalog import ZIM_CATALOG

KIWIX_BASE = "https://download.kiwix.org/zim"
TIMEOUT_S = 15

# Match ZIM filenames like ``wikipedia_en_all_maxi_2025-11.zim``.
_ZIM_RE = re.compile(r'href="([^"/]+\.zim)"')


def _list_dir(kiwix_dir: str) -> list[str]:
    """Return the list of ZIM filenames in the given CDN directory."""
    url = f"{KIWIX_BASE}/{kiwix_dir}/"
    req = Request(url, headers={"User-Agent": "lokidoki-catalog-validator/1.0"})
    try:
        with urlopen(req, timeout=TIMEOUT_S) as resp:  # noqa: S310 — trusted host
            if resp.status != 200:
                return []
            body = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001 — surface every failure as empty
        print(f"  ! failed to fetch {url}: {exc}")
        return []
    return _ZIM_RE.findall(body)


def _slug_matches(slug: str, filename: str) -> bool:
    """True when ``slug`` appears as a whole segment inside ``filename``.

    Mirrors the resolver's matching: the slug must be present as part of
    the filename before the trailing ``_<date>.zim``. Simple substring
    check is sufficient since slugs are specific enough in practice.
    """
    return slug and slug in filename


def validate() -> tuple[int, int, list[str]]:
    """Return (valid_variants, total_variants, error_lines)."""
    cache: dict[str, list[str]] = {}
    total = 0
    valid = 0
    errors: list[str] = []

    for source in ZIM_CATALOG:
        if source.is_topic_picker:
            # Stack Exchange uses per-topic lookup, skip here.
            continue
        if source.kiwix_dir not in cache:
            cache[source.kiwix_dir] = _list_dir(source.kiwix_dir)
        files = cache[source.kiwix_dir]

        for variant in source.variants:
            total += 1
            if not variant.url_slug:
                errors.append(
                    f"  X {source.source_id}/{variant.key}: empty url_slug"
                )
                continue
            matches = [f for f in files if _slug_matches(variant.url_slug, f)]
            if matches:
                newest = sorted(matches)[-1]
                valid += 1
                print(
                    f"  OK  {source.source_id:24s} {variant.key:10s} -> {newest}"
                )
            else:
                errors.append(
                    f"  X {source.source_id}/{variant.key}: no file "
                    f"matching '{variant.url_slug}' in /zim/{source.kiwix_dir}/"
                )
    return valid, total, errors


def main() -> int:
    print(f"Validating {len(ZIM_CATALOG)} catalog entries against {KIWIX_BASE}\n")
    valid, total, errors = validate()
    print(f"\n{valid}/{total} variants valid")
    if errors:
        print("\nErrors:")
        for line in errors:
            print(line)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
