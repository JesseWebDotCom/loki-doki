"""Character system Phase 1 tests.

Two-tier shape: ``characters`` is the admin-managed catalog,
``character_overrides_user`` shadows fields per user, and
``character_settings_user`` holds the per-user active pointer.
"""
from __future__ import annotations

import pytest

from lokidoki.core import character_access as access
from lokidoki.core import character_ops as ops
from lokidoki.core.memory_init import open_and_migrate


@pytest.fixture
def conn(tmp_path):
    c, _ = open_and_migrate(str(tmp_path / "char.db"))
    # Seed two users so FK constraints on character_overrides_user /
    # character_settings_user resolve.
    c.execute(
        "INSERT INTO users (id, username, role) VALUES "
        "(1, 'alice', 'admin'), (2, 'bob', 'user')"
    )
    c.commit()
    yield c
    c.close()


class TestSchema:
    def test_character_tables_exist(self, conn):
        rows = {
            r["name"]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert {
            "characters",
            "voices",
            "wakewords",
            "character_overrides_user",
            "character_settings_user",
        } <= rows


class TestCatalogCRUD:
    def test_create_and_get(self, conn):
        cid = ops.create_character(
            conn,
            name="Loki",
            description="Mischievous helper",
            behavior_prompt="Speak with playful wit.",
            avatar_style="bottts",
            avatar_seed="loki-1",
            source="builtin",
        )
        row = ops.get_character(conn, cid)
        assert row["name"] == "Loki"
        assert row["behavior_prompt"] == "Speak with playful wit."
        assert row["source"] == "builtin"

    def test_list(self, conn):
        ops.create_character(conn, name="A", source="builtin")
        ops.create_character(conn, name="B", source="user")
        assert {r["name"] for r in ops.list_characters(conn)} == {"A", "B"}

    def test_update(self, conn):
        cid = ops.create_character(conn, name="A", source="user")
        ops.update_character(conn, cid, behavior_prompt="new")
        assert ops.get_character(conn, cid)["behavior_prompt"] == "new"

    def test_delete_user_character(self, conn):
        cid = ops.create_character(conn, name="A", source="user")
        ops.delete_character(conn, cid)
        assert ops.get_character(conn, cid) is None

    def test_delete_builtin_blocked(self, conn):
        cid = ops.create_character(conn, name="Default", source="builtin")
        with pytest.raises(ValueError):
            ops.delete_character(conn, cid)

    def test_builtin_edit_is_in_place(self, conn):
        cid = ops.create_character(conn, name="Default", source="builtin")
        same_id = ops.edit_character(conn, cid, behavior_prompt="custom")
        assert same_id == cid
        row = ops.get_character(conn, cid)
        assert row["behavior_prompt"] == "custom"
        assert row["source"] == "builtin"

    def test_builtin_edit_survives_seeder_rerun(self, conn):
        from lokidoki.core import character_seed as seed
        # Pretend "Loki" is a builtin spec entry (BUILTIN_SPECS ships
        # one named Loki). Create the row, edit it, re-run the seeder,
        # confirm the edit is preserved.
        spec = next(s for s in seed.BUILTIN_SPECS if s["name"] == "Loki")
        cid = ops.create_character(
            conn,
            name=spec["name"],
            description=spec["description"],
            behavior_prompt=spec["behavior_prompt"],
            avatar_style=spec["avatar_style"],
            avatar_seed=spec["avatar_seed"],
            avatar_config=spec["avatar_config"],
            source="builtin",
        )
        ops.edit_character(conn, cid, behavior_prompt="user-edited")
        seed.seed_builtin_if_missing(conn)
        assert ops.get_character(conn, cid)["behavior_prompt"] == "user-edited"

    def test_reset_builtin_to_spec(self, conn):
        from lokidoki.core import character_seed as seed
        spec = next(s for s in seed.BUILTIN_SPECS if s["name"] == "Loki")
        cid = ops.create_character(
            conn,
            name=spec["name"],
            description="dummy",
            behavior_prompt="dummy",
            avatar_style=spec["avatar_style"],
            avatar_seed="other",
            source="builtin",
        )
        ops.reset_builtin_to_spec(conn, cid)
        row = ops.get_character(conn, cid)
        assert row["behavior_prompt"] == spec["behavior_prompt"]
        assert row["avatar_seed"] == spec["avatar_seed"]

    def test_reset_non_builtin_rejected(self, conn):
        cid = ops.create_character(conn, name="Loki", source="admin")
        with pytest.raises(ValueError):
            ops.reset_builtin_to_spec(conn, cid)


class TestUserOverrides:
    def test_override_shadows_catalog(self, conn):
        cid = ops.create_character(
            conn, name="Loki", behavior_prompt="catalog text", source="builtin"
        )
        ops.set_user_override(
            conn, user_id=2, character_id=cid, behavior_prompt="bob's text"
        )
        merged = ops.resolve_character_for_user(conn, 2, cid)
        assert merged["behavior_prompt"] == "bob's text"
        assert merged["has_user_overrides"] is True
        # Other user still sees catalog.
        merged_alice = ops.resolve_character_for_user(conn, 1, cid)
        assert merged_alice["behavior_prompt"] == "catalog text"
        assert merged_alice["has_user_overrides"] is False

    def test_clear_overrides_returns_to_catalog(self, conn):
        cid = ops.create_character(
            conn, name="Loki", behavior_prompt="catalog", source="builtin"
        )
        ops.set_user_override(
            conn, 2, cid, behavior_prompt="custom"
        )
        ops.clear_user_overrides(conn, 2, cid)
        merged = ops.resolve_character_for_user(conn, 2, cid)
        assert merged["behavior_prompt"] == "catalog"
        assert merged["has_user_overrides"] is False

    def test_voice_id_not_overridable(self, conn):
        cid = ops.create_character(conn, name="A", source="builtin")
        with pytest.raises(ValueError):
            ops.set_user_override(conn, 2, cid, voice_id="some-voice")

    def test_avatar_config_dict_round_trip(self, conn):
        cid = ops.create_character(
            conn,
            name="A",
            avatar_config={"eyes": "happy"},
            source="builtin",
        )
        merged = ops.resolve_character_for_user(conn, 2, cid)
        assert merged["avatar_config"] == {"eyes": "happy"}
        ops.set_user_override(
            conn, 2, cid, avatar_config={"eyes": "wink"}
        )
        merged = ops.resolve_character_for_user(conn, 2, cid)
        assert merged["avatar_config"] == {"eyes": "wink"}


class TestActivePerUser:
    def test_per_user_isolation(self, conn):
        a = ops.create_character(conn, name="A", source="builtin")
        b = ops.create_character(conn, name="B", source="user")
        ops.set_active_character(conn, user_id=1, cid=a)
        ops.set_active_character(conn, user_id=2, cid=b)
        assert ops.get_active_character_id(conn, 1) == a
        assert ops.get_active_character_id(conn, 2) == b

    def test_fallback_to_builtin_when_unset(self, conn):
        builtin = ops.create_character(conn, name="Default", source="builtin")
        ops.create_character(conn, name="Other", source="user")
        # User 2 has not set anything → falls back to builtin.
        assert ops.get_active_character_id(conn, 2) == builtin

    def test_active_falls_back_when_deleted(self, conn):
        builtin = ops.create_character(conn, name="Default", source="builtin")
        user_c = ops.create_character(conn, name="A", source="user")
        ops.set_active_character(conn, 2, user_c)
        ops.delete_character(conn, user_c)
        # FK SET NULL → fallback resolves to builtin.
        assert ops.get_active_character_id(conn, 2) == builtin


class TestAccessTiers:
    def test_default_visible(self, conn):
        cid = ops.create_character(conn, name="A", source="builtin")
        assert access.is_visible_to_user(conn, 2, cid) is True

    def test_global_disable_hides_from_everyone(self, conn):
        cid = ops.create_character(conn, name="A", source="builtin")
        access.set_global_enabled(conn, cid, False)
        assert access.is_visible_to_user(conn, 1, cid) is False
        assert access.is_visible_to_user(conn, 2, cid) is False

    def test_user_override_blocks_only_one_user(self, conn):
        cid = ops.create_character(conn, name="A", source="builtin")
        access.set_user_enabled(conn, user_id=2, character_id=cid, enabled=False)
        assert access.is_visible_to_user(conn, 1, cid) is True
        assert access.is_visible_to_user(conn, 2, cid) is False

    def test_user_override_can_be_cleared(self, conn):
        cid = ops.create_character(conn, name="A", source="builtin")
        access.set_user_enabled(conn, 2, cid, False)
        access.set_user_enabled(conn, 2, cid, None)  # clear
        assert access.is_visible_to_user(conn, 2, cid) is True

    def test_filter_visible_ids_batches(self, conn):
        a = ops.create_character(conn, name="A", source="builtin")
        b = ops.create_character(conn, name="B", source="builtin")
        c = ops.create_character(conn, name="C", source="user")
        access.set_global_enabled(conn, b, False)
        access.set_user_enabled(conn, 2, c, False)
        visible = access.filter_visible_ids(conn, 2, [a, b, c])
        assert visible == {a}

    def test_active_skips_disabled(self, conn):
        a = ops.create_character(conn, name="A", source="builtin")
        b = ops.create_character(conn, name="B", source="builtin")
        ops.set_active_character(conn, 2, a)
        # Admin disables A globally — user 2's active resolution falls
        # through to the next visible builtin.
        access.set_global_enabled(conn, a, False)
        assert ops.get_active_character_id(conn, 2) == b

    def test_list_visible_characters_for_user_filters(self, conn):
        a = ops.create_character(conn, name="A", source="builtin")
        b = ops.create_character(conn, name="B", source="user")
        access.set_user_enabled(conn, 2, b, False)
        names = {
            r["name"] for r in ops.list_visible_characters_for_user(conn, 2)
        }
        assert names == {"A"}

    def test_access_matrix_shape(self, conn):
        a = ops.create_character(conn, name="A", source="builtin")
        b = ops.create_character(conn, name="B", source="user")
        access.set_global_enabled(conn, b, False)
        access.set_user_enabled(conn, 2, a, False)
        matrix = access.list_user_access_matrix(conn, 2)
        by_id = {m["character_id"]: m for m in matrix}
        assert by_id[a]["global_enabled"] is True
        assert by_id[a]["user_override"] is False
        assert by_id[a]["effective"] is False
        assert by_id[b]["global_enabled"] is False
        assert by_id[b]["user_override"] is None
        assert by_id[b]["effective"] is False
