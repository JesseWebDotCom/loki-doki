"""Tests for chat memory context assembly and streaming wiring."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.modules.setdefault("jwt", MagicMock())
sys.modules.setdefault("PIL", MagicMock())
sys.modules.setdefault("PIL.Image", MagicMock())

from app import db
from app.chats import store as chat_store
from app.subsystems.memory import store as memory_store


def _load_api_module(module_name: str, relative_path: str):
    """Load one API module directly from disk without importing the package aggregator."""
    repo_root = Path(__file__).resolve().parents[1]
    package_name = "app.api"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(repo_root / "app" / "api")]
        sys.modules[package_name] = package
    module_path = repo_root / relative_path
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module at {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


chat_helpers = _load_api_module("app.api.chat_helpers", "app/api/chat_helpers.py")
chat_api = _load_api_module("app.api.chat", "app/api/chat.py")


class ChatMemoryContextTests(unittest.TestCase):
    """Verify active-chat memory is injected into chat flows."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        self.connection = db.connect(self.database_path)
        db.initialize_database(self.connection)
        self.user = db.create_user(self.connection, "jesse", "Jesse", "hashed")
        self.chat = chat_store.create_chat(self.connection, self.user["id"], "Scoped memory chat")

    def tearDown(self) -> None:
        self.connection.close()
        self._temp_dir.cleanup()

    def test_build_memory_context_includes_session_and_l1_memory(self) -> None:
        memory_store.write_memory(
            self.connection,
            scope="session",
            key="turn:00:user",
            value="We are talking about pizza tonight.",
            user_id=self.user["id"],
            chat_id=str(self.chat["id"]),
        )
        memory_store.write_memory(
            self.connection,
            scope="person",
            key="favorite_food",
            value="pizza",
            user_id=self.user["id"],
            character_id="pikachu",
            confidence=1.0,
        )

        dynamic_context = chat_helpers.build_memory_context(
            self.connection,
            self.user["id"],
            character_id="pikachu",
            chat_id=str(self.chat["id"]),
        )

        self.assertIn("<session_context>", dynamic_context)
        self.assertIn("We are talking about pizza tonight.", dynamic_context)
        self.assertIn("<memory_context>", dynamic_context)
        self.assertIn("favorite_food: pizza", dynamic_context)

    def test_memory_debug_payload_reports_session_and_long_term_usage(self) -> None:
        memory_store.write_memory(
            self.connection,
            scope="session",
            key="turn:00:user",
            value="We are talking about pizza tonight.",
            user_id=self.user["id"],
            chat_id=str(self.chat["id"]),
        )
        memory_store.write_memory(
            self.connection,
            scope="person",
            key="favorite_food",
            value="pizza",
            user_id=self.user["id"],
            character_id="pikachu",
            confidence=1.0,
        )

        payload = chat_helpers.memory_debug_payload(
            self.connection,
            self.user["id"],
            character_id="pikachu",
            chat_id=str(self.chat["id"]),
        )

        self.assertTrue(payload["used"])
        self.assertTrue(payload["session_applied"])
        self.assertTrue(payload["long_term_applied"])
        self.assertIn("pizza tonight", payload["session_preview"])
        self.assertIn("favorite_food: pizza", payload["long_term_preview"])

    def test_saved_chat_history_compacts_session_memory_into_summary_and_recent_turns(self) -> None:
        messages = [
            {"role": "user", "content": "For this chat, respond in one or two sentences."},
            {"role": "assistant", "content": "Okay, I will keep it short."},
            {"role": "user", "content": "Have you seen Everybody Loves Raymond?"},
            {"role": "assistant", "content": "I have not watched it, but I know the show."},
            {"role": "user", "content": "I just watched it last night on YouTube."},
            {"role": "assistant", "content": "Nice, sounds like you enjoyed it."},
            {"role": "user", "content": "What is it?"},
        ]

        chat_store.save_chat_history(self.connection, self.user["id"], str(self.chat["id"]), messages)

        session_rows = memory_store.list_memory(
            self.connection,
            "session",
            self.user["id"],
            chat_id=str(self.chat["id"]),
        )
        session_context = memory_store.get_session_context(self.connection, str(self.chat["id"]))

        self.assertEqual("summary:session", session_rows[0]["key"])
        self.assertEqual("summary:latest_user", session_rows[1]["key"])
        self.assertTrue(any(row["key"].startswith("recent:") for row in session_rows))
        self.assertIn("Session Summary:", session_context)
        self.assertIn("Latest User Goal:", session_context)
        self.assertIn("Recent User Turn:", session_context)

    def test_promote_person_facts_writes_recent_title_from_explicit_watch_message(self) -> None:
        written = memory_store.promote_person_facts(
            self.connection,
            self.user["id"],
            "pikachu",
            'I just watched "Everybody Loves Raymond" last night on YouTube.',
            [],
        )

        person_memories = memory_store.list_user_memory(self.connection, self.user["id"])

        self.assertTrue(any(fact["key"] == "recently_watched_title" for fact in written))
        self.assertTrue(any(memory["key"] == "recently_watched_title" for memory in person_memories))
        watched = next(memory for memory in person_memories if memory["key"] == "recently_watched_title")
        self.assertIn("Everybody Loves Raymond", watched["value"])
        self.assertIn("YouTube", watched["value"])

    def test_promote_person_facts_resolves_recent_title_from_history(self) -> None:
        history = [
            {"role": "user", "content": "Have you seen the TV show Everybody Loves Raymond?"},
            {"role": "assistant", "content": 'I have heard of "Everybody Loves Raymond."'},
        ]

        written = memory_store.promote_person_facts(
            self.connection,
            self.user["id"],
            "pikachu",
            "I just watched it last night on youtube.",
            history,
        )

        person_memories = memory_store.list_user_memory(self.connection, self.user["id"])

        self.assertTrue(any(fact["key"] == "last_discussed_title" for fact in written))
        discussed = next(memory for memory in person_memories if memory["key"] == "last_discussed_title")
        watched = next(memory for memory in person_memories if memory["key"] == "recently_watched_title")
        self.assertEqual("Everybody Loves Raymond", discussed["value"])
        self.assertIn("Everybody Loves Raymond", watched["value"])

    def test_promote_person_facts_captures_location_work_and_preference(self) -> None:
        memory_store.promote_person_facts(
            self.connection,
            self.user["id"],
            "pikachu",
            "I live in Brooklyn. I work at OpenAI. I prefer tea.",
            [],
        )

        person_memories = memory_store.list_user_memory(self.connection, self.user["id"])

        keys = {memory["key"]: memory["value"] for memory in person_memories}
        self.assertEqual("Brooklyn", keys["home_location"])
        self.assertEqual("OpenAI", keys["workplace"])
        self.assertEqual("tea", keys["stated_preference"])

    def test_promote_person_facts_captures_disliked_title(self) -> None:
        memory_store.promote_person_facts(
            self.connection,
            self.user["id"],
            "pikachu",
            'I hate "Some Show".',
            [],
        )

        person_memories = memory_store.list_user_memory(self.connection, self.user["id"])
        disliked = next(memory for memory in person_memories if memory["key"] == "disliked_title")
        self.assertEqual("Some Show", disliked["value"])

    def test_chat_stream_route_passes_display_name_and_scoped_memory(self) -> None:
        current_user = {**self.user, "display_name": "Jesse", "username": "jesse", "is_admin": True}
        request = chat_api.ChatRequest(message="Remember this", chat_id=str(self.chat["id"]), performance_profile_id="fast")
        fake_stream = type(
            "StreamResult",
            (),
            {
                "classification": type("ClassificationStub", (), {"request_type": "text_chat", "route": "fast_qwen", "reason": "stream"})(),
                "provider": type("ProviderStub", (), {"name": "llm_fast", "backend": "ollama", "model": "qwen-fast", "acceleration": "cpu"})(),
                "chunks": iter(["hello", " world"]),
            },
        )()

        with (
            patch.object(chat_api, "connection_scope", side_effect=lambda: db.connection_scope(self.database_path)),
            patch.object(chat_api, "runtime_context", return_value={"settings": {"profile": "mac"}, "providers": {"llm_fast": object(), "llm_thinking": object()}}),
            patch.object(chat_api.character_service, "build_rendering_context", return_value=type("RenderCtx", (), {"active_character_id": "pikachu"})()),
            patch.object(chat_api, "route_message_stream", return_value=fake_stream) as mock_stream,
            patch.object(chat_api, "build_memory_context", return_value="<session_context>\nturn\n</session_context>\n\n<memory_context>\nfacts\n</memory_context>") as mock_memory,
        ):
            response = chat_api.chat_message_stream_api(request, current_user=current_user)

        self.assertEqual("application/x-ndjson", response.media_type)
        mock_memory.assert_called_once()
        args = mock_stream.call_args.args
        self.assertEqual(args[0], "Remember this")
        self.assertEqual(args[1], "Jesse")
        self.assertEqual(args[2], "mac")
        self.assertEqual(args[3], [])
        self.assertIn("dynamic_context", mock_stream.call_args.kwargs)
        self.assertIn("<session_context>", mock_stream.call_args.kwargs["dynamic_context"])

    def test_chat_stream_route_returns_ndjson_and_persists_messages(self) -> None:
        current_user = {**self.user, "display_name": "Jesse", "username": "jesse", "is_admin": True}
        request = chat_api.ChatRequest(message="Remember this", chat_id=str(self.chat["id"]), performance_profile_id="fast")
        fake_stream = type(
            "StreamResult",
            (),
            {
                "classification": type("ClassificationStub", (), {"request_type": "text_chat", "route": "fast_qwen", "reason": "stream"})(),
                "provider": type("ProviderStub", (), {"name": "llm_fast", "backend": "ollama", "model": "qwen-fast", "acceleration": "cpu"})(),
                "chunks": iter(["hello", " world"]),
            },
        )()

        with (
            patch.object(chat_api, "connection_scope", side_effect=lambda: db.connection_scope(self.database_path)),
            patch.object(chat_api, "runtime_context", return_value={"settings": {"profile": "mac"}, "providers": {"llm_fast": object(), "llm_thinking": object()}}),
            patch.object(chat_api.character_service, "build_rendering_context", return_value=type("RenderCtx", (), {"active_character_id": "pikachu"})()),
            patch.object(chat_api, "route_message_stream", return_value=fake_stream),
            patch.object(chat_api, "build_memory_context", return_value="<memory_context>\nfacts\n</memory_context>"),
        ):
            response = chat_api.chat_message_stream_api(request, current_user=current_user)

        payload_chunks: list[str] = []

        async def collect() -> None:
            async for chunk in response.body_iterator:
                payload_chunks.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))

        asyncio.run(collect())
        events = [json.loads(line) for line in "".join(payload_chunks).splitlines() if line.strip()]

        self.assertEqual("meta", events[0]["type"])
        self.assertEqual("delta", events[1]["type"])
        self.assertEqual("delta", events[2]["type"])
        self.assertEqual("done", events[3]["type"])
        self.assertEqual("hello world", events[3]["message"]["content"])

        with db.connection_scope(self.database_path) as connection:
            history = chat_store.load_chat_history(connection, self.user["id"], str(self.chat["id"]))
        self.assertEqual("Remember this", history[-2]["content"])
        self.assertEqual("hello world", history[-1]["content"])


if __name__ == "__main__":
    unittest.main()
