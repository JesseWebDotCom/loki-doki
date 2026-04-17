"""Test archive config/state JSON persistence."""
import pytest
from pathlib import Path

from lokidoki.archives import store
from lokidoki.archives.models import ArchiveConfig, ArchiveState


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    yield
    store.set_data_dir(None)


# ── Config ──────────────────────────────────────────────────────

def test_load_empty():
    assert store.load_configs() == []


def test_upsert_and_load():
    cfg = ArchiveConfig(source_id="wikipedia", enabled=True, variant="mini")
    store.upsert_config(cfg)
    loaded = store.load_configs()
    assert len(loaded) == 1
    assert loaded[0].source_id == "wikipedia"
    assert loaded[0].variant == "mini"


def test_upsert_replaces():
    store.upsert_config(ArchiveConfig(source_id="wikipedia", enabled=True, variant="mini"))
    store.upsert_config(ArchiveConfig(source_id="wikipedia", enabled=False, variant="nopic"))
    loaded = store.load_configs()
    assert len(loaded) == 1
    assert loaded[0].variant == "nopic"
    assert loaded[0].enabled is False


def test_get_config():
    store.upsert_config(ArchiveConfig(source_id="ifixit", enabled=True, variant="all"))
    assert store.get_config("ifixit") is not None
    assert store.get_config("nonexistent") is None


def test_remove_config():
    store.upsert_config(ArchiveConfig(source_id="ifixit", enabled=True, variant="all"))
    store.remove_config("ifixit")
    assert store.get_config("ifixit") is None


# ── State ───────────────────────────────────────────────────────

def test_state_round_trip():
    st = ArchiveState(
        source_id="wikipedia",
        variant="mini",
        language="en",
        file_path="/data/archives/zim/wikipedia_en_mini_2025-03.zim",
        file_size_bytes=8_000_000_000,
        zim_date="2025-03",
        download_complete=True,
        downloaded_at="2025-04-01T12:00:00Z",
    )
    store.upsert_state(st)
    loaded = store.load_states()
    assert len(loaded) == 1
    assert loaded[0].file_size_bytes == 8_000_000_000
    assert loaded[0].download_complete is True


def test_remove_state():
    store.upsert_state(ArchiveState(
        source_id="ifixit", variant="all", language="en",
        file_path="/tmp/test.zim", file_size_bytes=100,
        zim_date="2025-01", download_complete=True,
    ))
    store.remove_state("ifixit")
    assert store.get_state("ifixit") is None


def test_corrupt_config_returns_empty(tmp_path):
    (tmp_path / "archives_config.json").write_text("not json!!!")
    assert store.load_configs() == []


def test_corrupt_state_returns_empty(tmp_path):
    (tmp_path / "archives_state.json").write_text("{bad}")
    assert store.load_states() == []


def test_default_archive_dir():
    d = store.default_archive_dir()
    assert "archives" in str(d)
    assert "zim" in str(d)
