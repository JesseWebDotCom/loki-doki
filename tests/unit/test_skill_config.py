"""Unit tests for the per-skill global+user config layer."""
from __future__ import annotations

import sqlite3
from unittest.mock import AsyncMock, MagicMock

import pytest

from lokidoki.core import skill_config as cfg
from lokidoki.core.decomposer import Ask
from lokidoki.core.memory_init import open_and_migrate
from lokidoki.core.orchestrator_skills import run_skills
from lokidoki.core.skill_executor import SkillExecutor


@pytest.fixture()
def conn(tmp_path):
    db = tmp_path / "t.db"
    c, _ = open_and_migrate(str(db))
    # Need a real user row for FK on skill_config_user.
    c.execute(
        "INSERT INTO users (username, role, status) VALUES ('alice', 'user', 'active')"
    )
    c.commit()
    yield c
    c.close()


def _user_id(conn: sqlite3.Connection) -> int:
    return int(conn.execute("SELECT id FROM users WHERE username='alice'").fetchone()["id"])


class TestRoundTrip:
    def test_global_set_and_get(self, conn):
        cfg.set_global_value(conn, "weather_owm", "owm_api_key", "ABC")
        assert cfg.get_global_config(conn, "weather_owm") == {"owm_api_key": "ABC"}

    def test_user_set_and_get(self, conn):
        uid = _user_id(conn)
        cfg.set_user_value(conn, uid, "weather_owm", "default_location", "98101")
        assert cfg.get_user_config(conn, uid, "weather_owm") == {"default_location": "98101"}

    def test_merge_user_overrides_global(self, conn):
        uid = _user_id(conn)
        cfg.set_global_value(conn, "weather_owm", "owm_api_key", "GLOBAL")
        cfg.set_user_value(conn, uid, "weather_owm", "owm_api_key", "USER")
        cfg.set_user_value(conn, uid, "weather_owm", "default_location", "90210")
        merged = cfg.get_merged_config(conn, uid, "weather_owm")
        assert merged == {"owm_api_key": "USER", "default_location": "90210"}

    def test_merge_no_user(self, conn):
        cfg.set_global_value(conn, "weather_owm", "owm_api_key", "GLOBAL")
        assert cfg.get_merged_config(conn, None, "weather_owm") == {"owm_api_key": "GLOBAL"}

    def test_upsert_overwrites(self, conn):
        cfg.set_global_value(conn, "weather_owm", "owm_api_key", "v1")
        cfg.set_global_value(conn, "weather_owm", "owm_api_key", "v2")
        assert cfg.get_global_config(conn, "weather_owm") == {"owm_api_key": "v2"}

    def test_delete(self, conn):
        uid = _user_id(conn)
        cfg.set_user_value(conn, uid, "weather_owm", "default_location", "x")
        assert cfg.delete_user_value(conn, uid, "weather_owm", "default_location") is True
        assert cfg.get_user_config(conn, uid, "weather_owm") == {}

    def test_non_string_types_survive(self, conn):
        cfg.set_global_value(conn, "x", "n", 42)
        cfg.set_global_value(conn, "x", "b", True)
        cfg.set_global_value(conn, "x", "f", 1.5)
        got = cfg.get_global_config(conn, "x")
        assert got == {"n": 42, "b": True, "f": 1.5}


class TestCoerceValue:
    def test_string(self):
        assert cfg.coerce_value(123, "string") == "123"
        assert cfg.coerce_value(None, "string") == ""

    def test_integer(self):
        assert cfg.coerce_value("42", "integer") == 42
        with pytest.raises(ValueError):
            cfg.coerce_value("nope", "integer")

    def test_number(self):
        assert cfg.coerce_value("1.5", "number") == 1.5

    def test_boolean(self):
        assert cfg.coerce_value("true", "boolean") is True
        assert cfg.coerce_value("0", "boolean") is False
        assert cfg.coerce_value(1, "boolean") is True

    def test_unknown_type(self):
        with pytest.raises(ValueError):
            cfg.coerce_value("x", "frobnicate")


class TestEnabledCheck:
    SCHEMA = {
        "global": [
            {"key": "owm_api_key", "type": "secret", "required": True},
        ],
        "user": [
            {"key": "owm_api_key", "type": "secret"},
            {"key": "default_location", "type": "string"},
        ],
    }

    USER_REQ_SCHEMA = {
        "global": [],
        "user": [
            {"key": "zip", "type": "string", "required": True},
        ],
    }

    BOTH_TIERS_SAME_KEY = {
        "global": [{"key": "key1", "type": "secret", "required": True}],
        "user":   [{"key": "key1", "type": "secret", "required": True}],
    }

    def test_required_keys_unique(self):
        assert cfg.required_keys(self.BOTH_TIERS_SAME_KEY) == ["key1"]

    def test_no_schema_always_enabled(self):
        ok, missing = cfg.check_enabled({}, {})
        assert ok is True
        assert missing == []

    def test_no_required_fields_enabled(self):
        ok, missing = cfg.check_enabled({}, {"global": [], "user": [{"key": "x"}]})
        assert ok is True
        assert missing == []

    def test_missing_required(self):
        ok, missing = cfg.check_enabled({}, self.SCHEMA)
        assert ok is False
        assert missing == ["owm_api_key"]

    def test_satisfied_by_global(self):
        ok, missing = cfg.check_enabled({"owm_api_key": "K"}, self.SCHEMA)
        assert ok is True
        assert missing == []

    def test_satisfied_by_user_override(self):
        # user-tier value alone is enough — merge wins on user side anyway
        ok, _ = cfg.check_enabled({"owm_api_key": "user_key"}, self.SCHEMA)
        assert ok is True

    def test_user_tier_required_field(self):
        ok, missing = cfg.check_enabled({}, self.USER_REQ_SCHEMA)
        assert ok is False and missing == ["zip"]
        ok, _ = cfg.check_enabled({"zip": "98101"}, self.USER_REQ_SCHEMA)
        assert ok is True

    def test_empty_string_counts_as_missing(self):
        ok, missing = cfg.check_enabled({"owm_api_key": "   "}, self.SCHEMA)
        assert ok is False
        assert missing == ["owm_api_key"]

    def test_falsy_bool_still_filled(self):
        schema = {"global": [{"key": "flag", "type": "boolean", "required": True}]}
        ok, _ = cfg.check_enabled({"flag": False}, schema)
        assert ok is True


class TestSchemaHelpers:
    SCHEMA = {
        "global": [
            {"key": "owm_api_key", "type": "secret", "label": "Key"},
        ],
        "user": [
            {"key": "default_location", "type": "string"},
        ],
    }

    def test_find_field(self):
        assert cfg.find_field(self.SCHEMA, "global", "owm_api_key")["type"] == "secret"
        assert cfg.find_field(self.SCHEMA, "user", "default_location")["type"] == "string"
        assert cfg.find_field(self.SCHEMA, "global", "missing") is None
        assert cfg.find_field({}, "global", "x") is None

    def test_mask_secrets(self):
        masked = cfg.mask_secrets({"owm_api_key": "SECRET"}, self.SCHEMA, "global")
        assert masked == {"owm_api_key": {"_set": True}}

    def test_mask_secrets_unset(self):
        masked = cfg.mask_secrets({"owm_api_key": ""}, self.SCHEMA, "global")
        assert masked == {"owm_api_key": {"_set": False}}

    def test_mask_secrets_passthrough_non_secret(self):
        masked = cfg.mask_secrets({"default_location": "98101"}, self.SCHEMA, "user")
        assert masked == {"default_location": "98101"}


class TestToggles:
    def test_global_toggle_default_on(self, conn):
        assert cfg.get_global_toggle(conn, "weather_owm") is True

    def test_user_toggle_default_on(self, conn):
        uid = _user_id(conn)
        assert cfg.get_user_toggle(conn, uid, "weather_owm") is True

    def test_set_and_get_global_toggle(self, conn):
        cfg.set_global_toggle(conn, "weather_owm", False)
        assert cfg.get_global_toggle(conn, "weather_owm") is False
        cfg.set_global_toggle(conn, "weather_owm", True)
        assert cfg.get_global_toggle(conn, "weather_owm") is True

    def test_set_and_get_user_toggle(self, conn):
        uid = _user_id(conn)
        cfg.set_user_toggle(conn, uid, "weather_owm", False)
        assert cfg.get_user_toggle(conn, uid, "weather_owm") is False


class TestComputeState:
    SCHEMA = {
        "global": [{"key": "k", "type": "secret", "required": True}],
        "user": [],
    }

    def test_all_gates_open(self):
        s = cfg.compute_skill_state(
            merged_config={"k": "v"}, schema=self.SCHEMA,
            global_toggle=True, user_toggle=True,
        )
        assert s["enabled"] is True
        assert s["disabled_reason"] is None

    def test_global_toggle_off(self):
        s = cfg.compute_skill_state(
            merged_config={"k": "v"}, schema=self.SCHEMA,
            global_toggle=False, user_toggle=True,
        )
        assert s["enabled"] is False
        assert s["disabled_reason"] == "global_toggle"

    def test_user_toggle_off(self):
        s = cfg.compute_skill_state(
            merged_config={"k": "v"}, schema=self.SCHEMA,
            global_toggle=True, user_toggle=False,
        )
        assert s["disabled_reason"] == "user_toggle"

    def test_config_missing_when_toggles_on(self):
        s = cfg.compute_skill_state(
            merged_config={}, schema=self.SCHEMA,
            global_toggle=True, user_toggle=True,
        )
        assert s["disabled_reason"] == "config"
        assert s["missing_required"] == ["k"]

    def test_global_toggle_takes_precedence_over_config(self):
        s = cfg.compute_skill_state(
            merged_config={}, schema=self.SCHEMA,
            global_toggle=False, user_toggle=True,
        )
        assert s["disabled_reason"] == "global_toggle"


class TestRunSkillsDisabled:
    """Disabled-skill gating in the orchestrator routing layer."""

    @pytest.mark.anyio
    async def test_disabled_skill_skipped_and_logged(self):
        # Manifest with a required global field that is NOT set.
        manifest = {
            "skill_id": "weather_owm",
            "intents": ["get_weather"],
            "parameters": {},
            "config_schema": {
                "global": [
                    {"key": "owm_api_key", "type": "secret", "required": True}
                ],
                "user": [],
            },
            "mechanisms": [{"method": "owm_api", "priority": 1, "timeout_ms": 1000}],
        }

        registry = MagicMock()
        registry.get_skill_by_intent.return_value = manifest
        registry.get_mechanisms.return_value = manifest["mechanisms"]

        memory = MagicMock()
        # _load_state returns (merged_config, global_toggle, user_toggle)
        memory.run_sync = AsyncMock(return_value=({}, True, True))

        ask = Ask(ask_id="a1", intent="weather_owm.get_weather", distilled_query="weather")
        _, results, _, log = await run_skills(
            [ask], registry, SkillExecutor(), user_id=1, memory=memory,
        )

        assert results == {}  # never executed
        assert len(log) == 1
        assert log[0]["status"] == "disabled"
        assert log[0]["disabled_reason"] == "config"
        assert log[0]["missing_config"] == ["owm_api_key"]

    @pytest.mark.anyio
    async def test_enabled_when_required_filled(self):
        manifest = {
            "skill_id": "weather_owm",
            "intents": ["get_weather"],
            "parameters": {},
            "config_schema": {
                "global": [
                    {"key": "owm_api_key", "type": "secret", "required": True}
                ],
                "user": [],
            },
            "mechanisms": [{"method": "owm_api", "priority": 1, "timeout_ms": 1000}],
        }

        registry = MagicMock()
        registry.get_skill_by_intent.return_value = manifest
        registry.get_mechanisms.return_value = manifest["mechanisms"]

        memory = MagicMock()
        memory.run_sync = AsyncMock(
            return_value=({"owm_api_key": "ABC"}, True, True)
        )

        # Patch the singleton factory to return a stub skill that always succeeds.
        from lokidoki.core import skill_factory
        from lokidoki.core.skill_executor import BaseSkill, MechanismResult

        class _Stub(BaseSkill):
            async def execute_mechanism(self, method, parameters):
                return MechanismResult(success=True, data={"ok": True})

        skill_factory._skill_instances["weather_owm"] = _Stub()
        try:
            ask = Ask(
                ask_id="a1",
                intent="weather_owm.get_weather",
                distilled_query="weather",
            )
            _, results, _, log = await run_skills(
                [ask], registry, SkillExecutor(), user_id=1, memory=memory,
            )
        finally:
            skill_factory._skill_instances.pop("weather_owm", None)

        assert results["a1"].success is True
        assert log[0]["status"] == "success"

    @pytest.mark.anyio
    async def test_user_config_fills_required_param_when_decomposer_omits_it(self):
        """Repro for the 'is it going to rain today' bug.

        The decomposer routed to weather_openmeteo with empty
        parameters. Without the config-aware backstop, the orchestrator
        would fall back to the distilled_query ("is it going to rain
        today") and pass that as ``location``. With the fix, the user's
        merged config value wins.
        """
        manifest = {
            "skill_id": "weather_openmeteo",
            "intents": ["get_weather"],
            "parameters": {"location": {"type": "string", "required": True}},
            "config_schema": {
                "global": [],
                "user": [{"key": "location", "type": "string"}],
            },
            "mechanisms": [
                {"method": "open_meteo", "priority": 1, "timeout_ms": 1000}
            ],
        }
        registry = MagicMock()
        registry.get_skill_by_intent.return_value = manifest
        registry.get_mechanisms.return_value = manifest["mechanisms"]

        memory = MagicMock()
        # User has set their default location to "Seattle"
        memory.run_sync = AsyncMock(return_value=({"location": "Seattle"}, True, True))

        captured: dict = {}
        from lokidoki.core import skill_factory
        from lokidoki.core.skill_executor import BaseSkill, MechanismResult

        class _Stub(BaseSkill):
            async def execute_mechanism(self, method, parameters):
                captured.update(parameters)
                return MechanismResult(success=True, data={"ok": True})

        skill_factory._skill_instances["weather_openmeteo"] = _Stub()
        try:
            ask = Ask(
                ask_id="a1",
                intent="weather_openmeteo.get_weather",
                distilled_query="is it going to rain today",
            )
            _, results, _, _ = await run_skills(
                [ask], registry, SkillExecutor(), user_id=1, memory=memory,
            )
        finally:
            skill_factory._skill_instances.pop("weather_openmeteo", None)

        assert results["a1"].success is True
        # The skill should have received "Seattle" from config, not
        # the noisy distilled_query.
        assert captured["location"] == "Seattle"

    @pytest.mark.anyio
    async def test_decomposer_param_still_wins_over_config(self):
        """Decomposer-supplied params take precedence over config defaults."""
        manifest = {
            "skill_id": "weather_openmeteo",
            "intents": ["get_weather"],
            "parameters": {"location": {"type": "string", "required": True}},
            "config_schema": {
                "global": [],
                "user": [{"key": "location", "type": "string"}],
            },
            "mechanisms": [
                {"method": "open_meteo", "priority": 1, "timeout_ms": 1000}
            ],
        }
        registry = MagicMock()
        registry.get_skill_by_intent.return_value = manifest
        registry.get_mechanisms.return_value = manifest["mechanisms"]

        memory = MagicMock()
        memory.run_sync = AsyncMock(return_value=({"location": "Seattle"}, True, True))

        captured: dict = {}
        from lokidoki.core import skill_factory
        from lokidoki.core.skill_executor import BaseSkill, MechanismResult

        class _Stub(BaseSkill):
            async def execute_mechanism(self, method, parameters):
                captured.update(parameters)
                return MechanismResult(success=True, data={"ok": True})

        skill_factory._skill_instances["weather_openmeteo"] = _Stub()
        try:
            ask = Ask(
                ask_id="a1",
                intent="weather_openmeteo.get_weather",
                distilled_query="weather in Tokyo",
                parameters={"location": "Tokyo"},
            )
            _, _, _, _ = await run_skills(
                [ask], registry, SkillExecutor(), user_id=1, memory=memory,
            )
        finally:
            skill_factory._skill_instances.pop("weather_openmeteo", None)

        assert captured["location"] == "Tokyo"

    @pytest.mark.anyio
    async def test_user_toggle_off_skips_skill(self):
        manifest = {
            "skill_id": "weather_owm",
            "intents": ["get_weather"],
            "parameters": {},
            "config_schema": {"global": [], "user": []},
            "mechanisms": [{"method": "owm_api", "priority": 1, "timeout_ms": 1000}],
        }
        registry = MagicMock()
        registry.get_skill_by_intent.return_value = manifest
        registry.get_mechanisms.return_value = manifest["mechanisms"]

        memory = MagicMock()
        # config OK, global on, but user toggled off
        memory.run_sync = AsyncMock(return_value=({}, True, False))

        ask = Ask(ask_id="a1", intent="weather_owm.get_weather", distilled_query="x")
        _, results, _, log = await run_skills(
            [ask], registry, SkillExecutor(), user_id=1, memory=memory,
        )
        assert results == {}
        assert log[0]["status"] == "disabled"
        assert log[0]["disabled_reason"] == "user_toggle"
