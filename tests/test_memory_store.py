"""Tests for Phase 8 memory storage behavior."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app import db
from app.chats import store as chat_store
from app.subsystems.memory import store as memory_store


class MemoryStoreTests(unittest.TestCase):
    """Verify scoped memory persistence and isolation."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        self.connection = db.connect(self.database_path)
        db.initialize_database(self.connection)
        self.user_one = db.create_user(self.connection, "jesse", "Jesse", "hashed")
        self.user_two = db.create_user(self.connection, "bella", "Bella", "hashed")
        self.chat_one = chat_store.create_chat(self.connection, self.user_one["id"], "Chat one")
        self.chat_two = chat_store.create_chat(self.connection, self.user_one["id"], "Chat two")

    def tearDown(self) -> None:
        self.connection.close()
        self._temp_dir.cleanup()

    def test_session_memory_isolated_by_chat_and_removed_on_chat_delete(self) -> None:
        memory_store.write_memory(
            self.connection,
            scope="session",
            key="turn:00:user",
            value="Jesse asked about dinner",
            user_id=self.user_one["id"],
            chat_id=str(self.chat_one["id"]),
        )
        memory_store.write_memory(
            self.connection,
            scope="session",
            key="turn:00:user",
            value="Jesse asked about soccer",
            user_id=self.user_one["id"],
            chat_id=str(self.chat_two["id"]),
        )

        first_chat = memory_store.list_memory(
            self.connection,
            "session",
            self.user_one["id"],
            chat_id=str(self.chat_one["id"]),
        )
        second_chat = memory_store.list_memory(
            self.connection,
            "session",
            self.user_one["id"],
            chat_id=str(self.chat_two["id"]),
        )

        self.assertEqual(first_chat[0]["value"], "Jesse asked about dinner")
        self.assertEqual(second_chat[0]["value"], "Jesse asked about soccer")
        self.assertIn("Jesse asked about dinner", memory_store.get_session_context(self.connection, str(self.chat_one["id"])))
        self.assertEqual("", memory_store.get_l1_context(self.connection, self.user_one["id"], "pikachu"))

        chat_store.delete_chat(self.connection, self.user_one["id"], str(self.chat_one["id"]))
        remaining = memory_store.list_memory(
            self.connection,
            "session",
            self.user_one["id"],
            chat_id=str(self.chat_one["id"]),
        )
        self.assertEqual([], remaining)

    def test_person_memory_isolated_by_user_and_character(self) -> None:
        memory_store.write_memory(
            self.connection,
            scope="person",
            key="favorite_food",
            value="pizza",
            user_id=self.user_one["id"],
            character_id="pikachu",
            confidence=1.0,
        )
        memory_store.write_memory(
            self.connection,
            scope="person",
            key="favorite_food",
            value="salad",
            user_id=self.user_two["id"],
            character_id="pikachu",
            confidence=1.0,
        )
        memory_store.write_memory(
            self.connection,
            scope="person",
            key="favorite_food",
            value="ramen",
            user_id=self.user_one["id"],
            character_id="eevee",
            confidence=1.0,
        )

        user_one_rows = memory_store.list_memory(self.connection, "person", self.user_one["id"])
        user_two_rows = memory_store.list_memory(self.connection, "person", self.user_two["id"])
        pikachu_context = memory_store.get_l1_context(self.connection, self.user_one["id"], "pikachu")
        eevee_context = memory_store.get_l1_context(self.connection, self.user_one["id"], "eevee")

        self.assertEqual(2, len(user_one_rows))
        self.assertEqual(1, len(user_two_rows))
        self.assertIn("favorite_food: pizza", pikachu_context)
        self.assertNotIn("favorite_food: ramen", pikachu_context)
        self.assertIn("favorite_food: ramen", eevee_context)
        self.assertNotIn("favorite_food: salad", pikachu_context)

    def test_household_memory_is_independent_of_person_and_session_memory(self) -> None:
        memory_store.write_memory(
            self.connection,
            scope="household",
            key="pizza_night",
            value="Tuesday",
            user_id=self.user_one["id"],
            confidence=1.0,
        )
        memory_store.write_memory(
            self.connection,
            scope="person",
            key="dog_name",
            value="Biscuit",
            user_id=self.user_one["id"],
            character_id="pikachu",
            confidence=1.0,
        )
        memory_store.write_memory(
            self.connection,
            scope="session",
            key="turn:00:user",
            value="This stays in the chat only",
            user_id=self.user_one["id"],
            chat_id=str(self.chat_one["id"]),
        )

        household = memory_store.list_memory(self.connection, "household", self.user_one["id"])
        person = memory_store.list_memory(self.connection, "person", self.user_one["id"])
        session = memory_store.list_memory(
            self.connection,
            "session",
            self.user_one["id"],
            chat_id=str(self.chat_one["id"]),
        )
        context = memory_store.get_l1_context(self.connection, self.user_one["id"], "pikachu")

        self.assertEqual("pizza_night", household[0]["key"])
        self.assertEqual("dog_name", person[0]["key"])
        self.assertEqual("turn:00:user", session[0]["key"])
        self.assertIn("pizza_night: Tuesday", context)
        self.assertIn("dog_name: Biscuit", context)
        self.assertNotIn("This stays in the chat only", context)

    def test_sync_queue_tracks_person_and_household_writes_and_deletes(self) -> None:
        memory_store.write_memory(
            self.connection,
            scope="household",
            key="pet",
            value="Biscuit",
            user_id=self.user_one["id"],
            confidence=1.0,
        )
        memory_store.write_memory(
            self.connection,
            scope="person",
            key="allergy",
            value="onions",
            user_id=self.user_one["id"],
            character_id="pikachu",
            confidence=1.0,
        )
        memory_store.delete_memory(
            self.connection,
            "person",
            "allergy",
            self.user_one["id"],
            character_id="pikachu",
        )

        queue_rows = self.connection.execute(
            """
            SELECT table_name, operation, payload_json
            FROM memory_sync_queue
            ORDER BY id ASC
            """
        ).fetchall()
        delta = memory_store.sync_delta(self.connection, "node-1", "")

        self.assertEqual(3, len(queue_rows))
        self.assertEqual("mem_household_context", queue_rows[0]["table_name"])
        self.assertEqual("upsert", queue_rows[1]["operation"])
        self.assertEqual("delete", queue_rows[2]["operation"])
        self.assertEqual(1, len(delta["household_context"]))
        self.assertEqual([], delta["person_memories"])


if __name__ == "__main__":
    unittest.main()
