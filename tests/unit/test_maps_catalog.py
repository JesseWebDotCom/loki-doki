"""Catalog sanity tests — Chunk 2 of the offline-maps plan.

The catalog is the single source of truth for what regions the admin
panel can offer. These tests guard against common regressions: missing
states, dangling parent refs, and malformed URL templates.
"""
from __future__ import annotations

import re

import pytest

from lokidoki.maps.catalog import MAP_CATALOG, MapRegion, children_of


_URL_RE = re.compile(r"^https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=-]+$")


def test_catalog_has_at_least_50_us_states():
    states = [r for r in MAP_CATALOG.values() if r.parent_id == "us"]
    assert len(states) >= 50, f"only {len(states)} US states in catalog"


def test_every_region_has_valid_url_templates():
    for region in MAP_CATALOG.values():
        if region.is_parent_only:
            # Continents carry empty templates — nothing to validate.
            assert region.street_url_template == ""
            assert region.satellite_url_template == ""
            continue
        for field_name in (
            "street_url_template", "satellite_url_template",
            "valhalla_url_template", "pbf_url_template",
        ):
            value = getattr(region, field_name)
            assert _URL_RE.match(value), (
                f"{region.region_id}.{field_name} is not a valid URL: {value!r}"
            )


def test_parent_ids_resolve():
    ids = set(MAP_CATALOG.keys())
    for region in MAP_CATALOG.values():
        if region.parent_id is not None:
            assert region.parent_id in ids, (
                f"{region.region_id} references missing parent {region.parent_id!r}"
            )


def test_bbox_sanity():
    for region in MAP_CATALOG.values():
        min_lon, min_lat, max_lon, max_lat = region.bbox
        assert min_lon < max_lon, f"{region.region_id} bbox has min_lon >= max_lon"
        assert min_lat < max_lat, f"{region.region_id} bbox has min_lat >= max_lat"
        assert -180.0 <= min_lon <= 180.0
        assert -180.0 <= max_lon <= 180.0
        assert -90.0 <= min_lat <= 90.0
        assert -90.0 <= max_lat <= 90.0


def test_pi_local_build_flag_matches_rule():
    """``pi_local_build_ok`` must equal ``pbf_size_mb < 500`` for downloadable regions."""
    for region in MAP_CATALOG.values():
        if region.is_parent_only:
            continue
        expected = region.pbf_size_mb < 500.0
        assert region.pi_local_build_ok is expected, (
            f"{region.region_id}: pi_local_build_ok={region.pi_local_build_ok} "
            f"but pbf_size_mb={region.pbf_size_mb}"
        )


def test_children_of_us_are_states():
    children = children_of("us")
    codes = {c.region_id.split("-")[-1] for c in children}
    # A few well-known codes as a smoke check.
    for code in ("ca", "ct", "tx", "ny", "hi", "ak"):
        assert code in codes, f"missing us-{code} from US children"


def test_every_region_is_a_mapregion():
    for region in MAP_CATALOG.values():
        assert isinstance(region, MapRegion)
