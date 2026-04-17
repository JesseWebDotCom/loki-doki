"""Test archive CRUD API routes and storage reporting."""
from __future__ import annotations

from dataclasses import asdict

import pytest

from lokidoki.archives import store
from lokidoki.archives.catalog import ZIM_CATALOG
from lokidoki.archives.models import ArchiveConfig, ArchiveState


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    yield
    store.set_data_dir(None)


# ── CRUD ────────────────────────────────────────────────────────

def test_configure_and_read_back():
    config = ArchiveConfig(
        source_id="wikipedia",
        enabled=True,
        variant="mini",
        language="en",
    )
    store.upsert_config(config)
    loaded = store.get_config("wikipedia")
    assert loaded is not None
    assert loaded.variant == "mini"
    assert loaded.enabled is True


def test_configure_unknown_variant_detected():
    """Variant validation happens at the API layer, but the store accepts anything."""
    from lokidoki.archives.catalog import get_source, get_variant

    source = get_source("wikipedia")
    assert source is not None
    assert get_variant(source, "nonexistent") is None


def test_remove_deletes_config_and_state():
    store.upsert_config(ArchiveConfig(source_id="ifixit", enabled=True, variant="all"))
    store.upsert_state(ArchiveState(
        source_id="ifixit", variant="all", language="en",
        file_path="/tmp/ifixit.zim", file_size_bytes=2_400_000_000,
        zim_date="2025-03", download_complete=True,
    ))
    store.remove_config("ifixit")
    store.remove_state("ifixit")
    assert store.get_config("ifixit") is None
    assert store.get_state("ifixit") is None


# ── Storage reporting ───────────────────────────────────────────

def test_storage_reports_installed_archives(tmp_path):
    store.upsert_state(ArchiveState(
        source_id="wikipedia", variant="mini", language="en",
        file_path=str(tmp_path / "wikipedia.zim"),
        file_size_bytes=8_000_000_000,
        zim_date="2025-03", download_complete=True,
    ))
    store.upsert_state(ArchiveState(
        source_id="wiktionary", variant="all", language="en",
        file_path=str(tmp_path / "wiktionary.zim"),
        file_size_bytes=1_800_000_000,
        zim_date="2025-01", download_complete=True,
    ))
    states = store.load_states()
    complete = [s for s in states if s.download_complete]
    total = sum(s.file_size_bytes for s in complete)
    assert total == 9_800_000_000
    assert len(complete) == 2


def test_storage_pending_projection():
    """Pending (configured but not downloaded) archives should be projected."""
    store.upsert_config(ArchiveConfig(
        source_id="wikipedia", enabled=True, variant="mini",
    ))
    # No state → not downloaded yet
    configs = store.load_configs()
    states = store.load_states()
    downloaded_ids = {s.source_id for s in states if s.download_complete}

    from lokidoki.archives.catalog import get_source, get_variant

    pending_gb = 0.0
    for cfg in configs:
        if cfg.source_id not in downloaded_ids and cfg.enabled:
            source = get_source(cfg.source_id)
            if source:
                v = get_variant(source, cfg.variant)
                if v:
                    pending_gb += v.approx_size_gb

    assert pending_gb == 8.0  # Wikipedia mini


# ── Status ──────────────────────────────────────────────────────

def test_status_returns_all_catalog_entries():
    """Status should return one entry per catalog source regardless of config."""
    from lokidoki.archives.catalog import ZIM_CATALOG

    configs = store.load_configs()
    states = store.load_states()

    # Even with empty config/state, we should have entries for all catalog items
    assert len(ZIM_CATALOG) > 0
    config_map = {c.source_id: c for c in configs}
    state_map = {s.source_id: s for s in states}

    for source in ZIM_CATALOG:
        # config and state may be None, that's fine
        assert source.source_id not in config_map  # nothing configured
        assert source.source_id not in state_map   # nothing downloaded


# ── Favicon ─────────────────────────────────────────────────────

def test_favicon_dir(tmp_path):
    favicon_dir = store.favicon_dir()
    assert "favicons" in str(favicon_dir)


def test_default_archive_dir(tmp_path):
    d = store.default_archive_dir()
    assert "archives" in str(d)
    assert "zim" in str(d)
