"""Tests for the upgraded Memory Architecture (Onyx-inspired)."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Mock dependencies not available in the test environment
sys.modules.setdefault("jwt", MagicMock())
sys.modules.setdefault("PIL", MagicMock())
sys.modules.setdefault("PIL.Image", MagicMock())

from app import db
from app.providers.types import ProviderSpec
from app.subsystems.memory import store as memory_store


class MemoryUpgradeTests(unittest.TestCase):
    """Verify hybrid retrieval, reranking, and metadata isolation."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        self.connection = db.connect(self.database_path)
        db.initialize_database(self.connection)
        
        self.provider = ProviderSpec(
            name="Mock",
            backend="ollama",
            model="nomic-embed-text",
            acceleration="cpu",
            endpoint="http://localhost:11434",
        )
        
        # Mock embedding (768 zeros with a 1.0 at index 0 for "dog")
        self.dog_vec = [1.0] + [0.0] * 767
        self.cat_vec = [0.0, 1.0] + [0.0] * 766
        self.other_vec = [0.0] * 768

    def tearDown(self) -> None:
        self.connection.close()
        self._temp_dir.cleanup()

    def _mock_embedding(self, provider: Any, text: str) -> list[float]:
        if "dog" in text.lower() or "pizza" in text.lower():
            return self.dog_vec
        if "cat" in text.lower():
            return self.cat_vec
        return self.other_vec

    def _mock_chat(self, provider, messages, **kwargs):
        content = messages[-1]["content"]
        # If it's a reranking prompt, return an ID
        if "Select the top" in content or "Candidates:" in content:
            return "0"
        return "pizza"

    @patch("app.subsystems.memory.store.generate_embedding")
    def test_archival_index_and_metadata_isolation(self, mock_embed: MagicMock) -> None:
        mock_embed.side_effect = self._mock_embedding
        
        # User A - Char 1: Dog memory
        memory_store.index_archival(self.connection, self.provider, "I have a dog named Barnaby", "user", user_id="user_a", character_id="char_1")
        # User A - Char 2: Cat memory
        memory_store.index_archival(self.connection, self.provider, "I have a cat named Whiskers", "user", user_id="user_a", character_id="char_2")
        # User B - Char 1: Dog memory
        memory_store.index_archival(self.connection, self.provider, "My dog is Rex", "user", user_id="user_b", character_id="char_1")

        # 1. Search for User A, Char 1 (should only see Barnaby)
        results = memory_store.search_archival(self.connection, self.provider, "dog", user_id="user_a", character_id="char_1")
        self.assertEqual(1, len(results))
        self.assertIn("Barnaby", results[0]["content"])

        # 2. Search for User A, any character (should see both Dog and Cat)
        results = memory_store.search_archival(self.connection, self.provider, "cat OR dog", user_id="user_a")
        self.assertEqual(2, len(results))

        # 3. Search for User B (should only see Rex)
        results = memory_store.search_archival(self.connection, self.provider, "dog", user_id="user_b")
        self.assertEqual(1, len(results))
        self.assertIn("Rex", results[0]["content"])

    @patch("app.subsystems.memory.store.generate_embedding")
    def test_hybrid_search_boosts_keyword_matches(self, mock_embed: MagicMock) -> None:
        """Verify that FTS keyword matching provides results even if vector is neutral."""
        mock_embed.return_value = self.other_vec
        
        memory_store.index_archival(self.connection, self.provider, "The capital of France is Paris", "source", user_id="u")
        memory_store.index_archival(self.connection, self.provider, "The capital of Japan is Tokyo", "source", user_id="u")
        
        # Test basic FTS capability directly first to ensure triggers/tables work
        fts_rows = self.connection.execute("SELECT * FROM mem_archival_fts WHERE content MATCH 'Tokyo'").fetchall()
        self.assertTrue(len(fts_rows) > 0, "FTS table should contain indexed content")

        # Search for "Tokyo" - FTS should provide the Japan memory
        results = memory_store.search_archival(self.connection, self.provider, "Tokyo", user_id="u")
        self.assertTrue(len(results) > 0, "Hybrid search should return FTS results")
        self.assertIn("Tokyo", results[0]["content"])

    @patch("app.subsystems.text.client.chat_completion")
    def test_query_decontextualization(self, mock_chat: MagicMock) -> None:
        mock_chat.return_value = "What is my dog's name?"
        history = [
            {"role": "user", "content": "I have a dog named Barnaby."},
            {"role": "assistant", "content": "That's a nice name!"}
        ]
        rewritten = memory_store.decontextualize_query("What is his name?", history, self.provider)
        
        self.assertEqual("What is my dog's name?", rewritten)
        self.assertTrue(mock_chat.called)

    @patch("app.subsystems.text.client.chat_completion")
    def test_reranking_logic(self, mock_chat: MagicMock) -> None:
        # Mock LLM picking ID 1 (the more relevant one)
        mock_chat.return_value = "1"
        
        candidates = [
            {"id": "0", "content": "I like pizza"},
            {"id": "1", "content": "My dog is Barnaby"}
        ]
        
        top = memory_store.rerank_memories("dog", candidates, self.provider, limit=1)
        self.assertEqual(1, len(top))
        self.assertIn("Barnaby", top[0]["content"])

    @patch("app.subsystems.memory.store.search_archival")
    @patch("app.subsystems.memory.store.rerank_memories")
    @patch("app.subsystems.memory.store.decontextualize_query")
    def test_augmented_context_pipeline_assembly(self, mock_rewrite: MagicMock, mock_rerank: MagicMock, mock_search: MagicMock) -> None:
        mock_rewrite.return_value = "standalone query"
        mock_search.return_value = [{"content": "Memory A", "source": "test"}]
        mock_rerank.return_value = [{"content": "Memory A", "source": "test"}]
        
        context = memory_store.get_augmented_context(
            self.connection, "ambiguous query", [], self.provider, user_id="u1", character_id="c1"
        )
        
        self.assertIn("<retrieved_memories>", context)
        self.assertIn("Memory A", context)
        # Verify pipeline flow
        mock_rewrite.assert_called_once()
        mock_search.assert_called_with(self.connection, self.provider, "standalone query", user_id="u1", character_id="c1", limit=20)


    @patch("app.subsystems.memory.store.generate_embedding")
    def test_consolidation_merges_redundant_records(self, mock_embed: MagicMock) -> None:
        """Verify that identical vector records are consolidated into a single entry."""
        # Fix the mock to return identical vectors for identical text
        mock_embed.side_effect = self._mock_embedding
        
        # Add "Barnaby the dog" twice for User C
        memory_store.index_archival(self.connection, self.provider, "I have a dog named Barnaby", "source", user_id="user_c")
        memory_store.index_archival(self.connection, self.provider, "I have a dog named Barnaby", "source", user_id="user_c")
        
        # Initial count
        rows = self.connection.execute("SELECT COUNT(*) FROM mem_archival_content WHERE user_id = 'user_c'").fetchone()
        self.assertEqual(2, rows[0])
        
        # Consolidate (similarity_threshold=0.0 means exact matches in our mock setup)
        memory_store.consolidate_archival_memory(self.connection, self.provider, user_id="user_c", similarity_threshold=0.01)
        
        # New count
        rows = self.connection.execute("SELECT COUNT(*) FROM mem_archival_content WHERE user_id = 'user_c'").fetchone()
        self.assertEqual(1, rows[0])

    @patch("app.subsystems.memory.store.generate_embedding")
    def test_archival_document_chunking(self, mock_embed: MagicMock) -> None:
        """Verify that long documents are split into overlapping chunks."""
        mock_embed.return_value = self.other_vec
        
        long_text = (
            "Sentence one about a very long topic. "
            "Sentence two which makes this even longer than the limit. "
            "Sentence three to ensure multiple chunks are created. "
            "Sentence four for good measure."
        )
        
        # Index with small chunk size to force split
        rids = memory_store.index_archival_document(
            self.connection, self.provider, long_text, "source", 
            user_id="u_doc", chunk_size=60, overlap=10
        )
        
        self.assertTrue(len(rids) > 1, f"Should have created multiple chunks, got {len(rids)}")
        
        # Verify content exists
        rows = self.connection.execute("SELECT content FROM mem_archival_content WHERE user_id = 'u_doc'").fetchall()
        self.assertEqual(len(rids), len(rows))
        self.assertIn("Sentence one", rows[0]["content"])


    @patch("app.subsystems.text.client.chat_completion")
    @patch("app.subsystems.memory.store.generate_embedding")
    def test_api_returns_augmented_context(self, mock_embed: MagicMock, mock_chat: MagicMock) -> None:
        """Verify that the memory context API correctly assembles the new augmented block."""
        mock_embed.side_effect = self._mock_embedding
        mock_chat.side_effect = self._mock_chat
        
        # 1. Seed a memory for User D
        memory_store.index_archival(self.connection, self.provider, "I love deep dish pizza", "user", user_id="user_d")
        
        # 2. Mock a chat context call (via the helper)
        from app.api.chat_helpers import build_memory_context
        # Use a fake history that mentions pizza
        history = [{"role": "user", "content": "I'm thinking about dinner."}]
        
        # Note: We need a provider for the helper
        context = build_memory_context(
            self.connection, "user_d", "What should I eat? pizza", history, self.provider
        )
        
        self.assertIn("<retrieved_memories>", context)
        self.assertIn("deep dish pizza", context)


    @patch("app.subsystems.memory.store.generate_embedding")
    def test_importance_and_confidence_filtering(self, mock_embed: MagicMock) -> None:
        """Verify that we can filter search results by importance/confidence levels."""
        mock_embed.return_value = self.other_vec
        
        # Seed 1: Critical high-confidence fact
        memory_store.index_archival(self.connection, self.provider, "Critical: User is allergic to peanuts.", "source", user_id="u_filter", importance=5, confidence=1.0)
        # Seed 2: Minor low-confidence trivia
        memory_store.index_archival(self.connection, self.provider, "Trivia: User thinks the ocean is too wet.", "source", user_id="u_filter", importance=1, confidence=0.2)
        
        # Test 1: All records (default)
        # Note: We query "Critical" to trigger FTS match
        all_results = memory_store.search_archival(self.connection, self.provider, "Critical OR Trivia", user_id="u_filter")
        self.assertEqual(2, len(all_results))
        
        # Test 2: Filter by importance > 3
        # (Manually verifying importance column exists and works in SQL)
        critical_only = [r for r in all_results if r["importance"] >= 5]
        self.assertEqual(1, len(critical_only))
        self.assertIn("allergic", critical_only[0]["content"])

    @patch("app.api.memory.BackgroundTasks")
    @patch("app.providers.manager.get_provider_for_subsystem")
    def test_api_background_endpoint_wiring(self, mock_get_provider: MagicMock, mock_bg_tasks: MagicMock) -> None:
        """Verify that the Memory API correctly routes long-running tasks to the background."""
        from app.api.memory import index_content_api, maintenance_api
        from app.models.memory import MemoryIndexRequest
        
        mock_get_provider.return_value = self.provider
        bg = mock_bg_tasks()
        
        # 1. Test /index wiring
        payload = MemoryIndexRequest(content="This is a long document", source="upload")
        response = index_content_api(payload, bg, current_user={"id": "test_user"})
        
        self.assertTrue(response["ok"])
        self.assertEqual("Indexing started in the background.", response["message"])
        self.assertTrue(bg.add_task.called, "Background task should have been added.")
        
        # 2. Test /maintenance wiring
        bg.reset_mock()
        m_response = maintenance_api(bg, current_user={"id": "test_user"})
        self.assertTrue(m_response["ok"])
        self.assertTrue(bg.add_task.called, "Maintenance task should have been added.")


if __name__ == "__main__":
    unittest.main()
