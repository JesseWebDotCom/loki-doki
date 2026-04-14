"""Unit tests for the per-skill global+user config layer."""
from __future__ import annotations

import sqlite3

import pytest

from lokidoki.core import skill_config as cfg
from lokidoki.core.memory_init import open_and_migrate

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
        cfg.set_global_value(conn, "weather_owm", "owm_api_key", "first")
        cfg.set_global_value(conn, "weather_owm", "owm_api_key", "second")
        assert cfg.get_global_config(conn, "weather_owm") == {"owm_api_key": "second"}

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


