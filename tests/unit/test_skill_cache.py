"""Unit tests for the cross-skill result cache."""
from __future__ import annotations

import asyncio
from datetime import datetime, time as dtime, timedelta, timezone
from unittest.mock import patch

import pytest

from lokidoki.core.memory_init import open_and_migrate
from lokidoki.core.skill_cache import (
    CacheSpec,
    SkillResultCache,
    build_cache_key,
    resolve_cache_spec,
)
from lokidoki.core.skill_executor import (
    BaseSkill,
    MechanismResult,
    SkillExecutor,
)


# ---------- pure helpers ---------------------------------------------------


class TestCacheKey:
    def test_key_is_stable_across_dict_ordering(self):
        a = build_cache_key("s", "m", {"date": "2026-04-08", "zip": "06461"})
        b = build_cache_key("s", "m", {"zip": "06461", "date": "2026-04-08"})
        assert a == b

    def test_key_excludes_config_and_skip_flag(self):
        # _config (secrets) and _skip_cache (request flag) must NOT
        # influence the key — otherwise admin keys would partition
        # caches per-user and a "refresh" request would write a
        # parallel row instead of bypassing.
        plain = build_cache_key("s", "m", {"zip": "06461"})
        with_cfg = build_cache_key("s", "m", {
            "zip": "06461",
            "_config": {"default_zip": "06461", "secret": "abc"},
            "_skip_cache": True,
        })
        assert plain == with_cfg

    def test_different_params_yield_different_keys(self):
        assert build_cache_key("s", "m", {"date": "1"}) != build_cache_key("s", "m", {"date": "2"})

    def test_skill_isolation(self):
        assert build_cache_key("s1", "m", {}) != build_cache_key("s2", "m", {})


# ---------- TTL parsing ----------------------------------------------------


class TestResolveCacheSpec:
    def test_no_declaration_disables_caching(self):
        spec = resolve_cache_spec({"method": "x"}, {})
        assert not spec.enabled

    def test_manifest_seconds(self):
        spec = resolve_cache_spec({"cache": {"ttl_s": 60}}, {})
        assert spec.ttl_s == 60
        assert spec.enabled

    def test_manifest_keyword(self):
        spec = resolve_cache_spec({"cache": {"ttl": "until_local_midnight"}}, {})
        assert spec.ttl_keyword == "until_local_midnight"
        assert spec.enabled

    def test_admin_override_seconds_wins_over_manifest(self):
        spec = resolve_cache_spec(
            {"cache": {"ttl": "until_local_midnight"}},
            {"cache_ttl_override": "1800"},
        )
        assert spec.ttl_s == 1800
        assert spec.ttl_keyword is None

    def test_admin_override_off_disables_even_when_manifest_set(self):
        spec = resolve_cache_spec(
            {"cache": {"ttl": "until_local_midnight"}},
            {"cache_ttl_override": "off"},
        )
        assert not spec.enabled

    def test_admin_override_keyword(self):
        spec = resolve_cache_spec(
            {"cache": {"ttl_s": 30}},
            {"cache_ttl_override": "until_local_midnight"},
        )
        assert spec.ttl_keyword == "until_local_midnight"

    def test_invalid_override_falls_back_to_manifest(self):
        spec = resolve_cache_spec(
            {"cache": {"ttl_s": 60}},
            {"cache_ttl_override": "tomorrow-ish"},
        )
        # Bogus string → log warning, fall back to manifest default.
        assert spec.ttl_s == 60

    def test_until_local_midnight_expires_at_next_midnight(self):
        # Freeze "now" at noon local on 2026-04-08; expiry must be the
        # next 00:00 local converted to UTC, i.e. 2026-04-09 00:00 local.
        spec = CacheSpec(ttl_keyword="until_local_midnight")
        fake_now = datetime(2026, 4, 8, 16, 0, tzinfo=timezone.utc)
        exp = spec.expires_at(now=fake_now)
        assert exp is not None
        # Check the LOCAL date one second past expiry — must be tomorrow.
        local = exp.astimezone()
        assert local.time() == dtime.min, f"expected midnight local, got {local.time()}"

    def test_seconds_expiry_is_now_plus_n(self):
        spec = CacheSpec(ttl_s=120)
        fake_now = datetime(2026, 4, 8, 12, 0, tzinfo=timezone.utc)
        exp = spec.expires_at(now=fake_now)
        assert exp == fake_now + timedelta(seconds=120)


# ---------- SQLite-backed round trip --------------------------------------


class _FakeMemory:
    """Minimal stand-in for MemoryProvider that just runs the fn synchronously."""

    def __init__(self, conn):
        self._conn = conn

    async def run_sync(self, fn):
        return fn(self._conn)


@pytest.fixture()
def memory(tmp_path):
    conn, _ = open_and_migrate(str(tmp_path / "cache.db"))
    yield _FakeMemory(conn)
    conn.close()


class TestCacheRoundTrip:
    @pytest.mark.anyio
    async def test_put_then_get_returns_same_data(self, memory):
        cache = SkillResultCache(memory)
        await cache.put(
            skill_id="movies_fandango",
            mechanism="napi_theaters_with_showtimes",
            key="abc123",
            data={"theaters": [{"name": "AMC"}], "lead": "Now playing"},
            source_url="https://example.com",
            source_title="Fandango",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        hit = await cache.get("movies_fandango", "napi_theaters_with_showtimes", "abc123")
        assert hit is not None
        assert hit.data["lead"] == "Now playing"
        assert hit.source_url == "https://example.com"
        assert hit.mechanism == "napi_theaters_with_showtimes"

    @pytest.mark.anyio
    async def test_expired_row_treated_as_miss(self, memory):
        cache = SkillResultCache(memory)
        await cache.put(
            skill_id="s", mechanism="m", key="exp",
            data={"x": 1}, source_url="", source_title="",
            expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        )
        assert await cache.get("s", "m", "exp") is None

    @pytest.mark.anyio
    async def test_invalidate_skill_wipes_only_matching_rows(self, memory):
        cache = SkillResultCache(memory)
        for sid, key in [("a", "k1"), ("a", "k2"), ("b", "k3")]:
            await cache.put(
                skill_id=sid, mechanism="m", key=key,
                data={"v": key}, source_url="", source_title="",
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            )
        wiped = await cache.invalidate_skill("a")
        assert wiped == 2
        assert await cache.get("a", "m", "k1") is None
        assert await cache.get("b", "m", "k3") is not None

    @pytest.mark.anyio
    async def test_no_memory_is_no_op(self):
        cache = SkillResultCache(None)
        await cache.put(
            skill_id="s", mechanism="m", key="k", data={}, source_url="",
            source_title="", expires_at=None,
        )
        assert await cache.get("s", "m", "k") is None


# ---------- Executor integration -------------------------------------------


class _CountingSkill(BaseSkill):
    """Counts how many times execute_mechanism actually fires.

    Cache hits MUST short-circuit before reaching this skill — the
    counter is the load-bearing assertion in every executor test.
    """

    def __init__(self):
        self.calls = 0

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        self.calls += 1
        return MechanismResult(
            success=True,
            data={"theaters": ["AMC"], "n": self.calls},
            source_url="https://example.com",
            source_title="example",
        )


_CACHED_MECHANISMS = [
    {"method": "napi", "priority": 0, "timeout_ms": 5000,
     "cache": {"ttl_s": 3600}},
]
_UNCACHED_MECHANISMS = [
    {"method": "napi", "priority": 0, "timeout_ms": 5000},
]


class TestExecutorCacheIntegration:
    @pytest.mark.anyio
    async def test_first_call_misses_second_call_hits(self, memory):
        executor = SkillExecutor(cache=SkillResultCache(memory))
        skill = _CountingSkill()
        params = {"zip": "06461"}

        r1 = await executor.execute_skill(skill, _CACHED_MECHANISMS, params, skill_id="movies_fandango")
        r2 = await executor.execute_skill(skill, _CACHED_MECHANISMS, params, skill_id="movies_fandango")

        assert r1.success and r2.success
        assert skill.calls == 1, f"expected one live call, got {skill.calls}"
        # Second call's mechanism log entry must record a cache_hit so
        # observability stays honest about where the data came from.
        assert any(e["status"] == "cache_hit" for e in r2.mechanism_log)

    @pytest.mark.anyio
    async def test_skip_cache_param_forces_live_fetch(self, memory):
        executor = SkillExecutor(cache=SkillResultCache(memory))
        skill = _CountingSkill()
        params = {"zip": "06461"}

        await executor.execute_skill(skill, _CACHED_MECHANISMS, params, skill_id="s")
        await executor.execute_skill(
            skill, _CACHED_MECHANISMS, {**params, "_skip_cache": True}, skill_id="s",
        )
        assert skill.calls == 2

    @pytest.mark.anyio
    async def test_no_cache_declaration_means_no_caching(self, memory):
        executor = SkillExecutor(cache=SkillResultCache(memory))
        skill = _CountingSkill()
        await executor.execute_skill(skill, _UNCACHED_MECHANISMS, {"zip": "06461"}, skill_id="s")
        await executor.execute_skill(skill, _UNCACHED_MECHANISMS, {"zip": "06461"}, skill_id="s")
        assert skill.calls == 2

    @pytest.mark.anyio
    async def test_failed_results_are_not_cached(self, memory):
        class _FailingSkill(BaseSkill):
            def __init__(self):
                self.calls = 0
            async def execute_mechanism(self, method, parameters):
                self.calls += 1
                return MechanismResult(success=False, error="boom")
        executor = SkillExecutor(cache=SkillResultCache(memory))
        skill = _FailingSkill()
        await executor.execute_skill(skill, _CACHED_MECHANISMS, {"zip": "x"}, skill_id="s")
        await executor.execute_skill(skill, _CACHED_MECHANISMS, {"zip": "x"}, skill_id="s")
        assert skill.calls == 2

    @pytest.mark.anyio
    async def test_admin_override_off_bypasses_cache(self, memory):
        executor = SkillExecutor(cache=SkillResultCache(memory))
        skill = _CountingSkill()
        # User config says caching is off — even though the manifest
        # declares a TTL, the override wins and every call hits live.
        params = {"zip": "x", "_config": {"cache_ttl_override": "off"}}
        await executor.execute_skill(skill, _CACHED_MECHANISMS, params, skill_id="s")
        await executor.execute_skill(skill, _CACHED_MECHANISMS, params, skill_id="s")
        assert skill.calls == 2

    @pytest.mark.anyio
    async def test_no_cache_when_executor_unconfigured(self, memory):
        # Bare executor (no cache instance) must behave exactly like
        # the pre-cache executor — every call goes live.
        executor = SkillExecutor()  # cache=None
        skill = _CountingSkill()
        await executor.execute_skill(skill, _CACHED_MECHANISMS, {"zip": "x"}, skill_id="s")
        await executor.execute_skill(skill, _CACHED_MECHANISMS, {"zip": "x"}, skill_id="s")
        assert skill.calls == 2
