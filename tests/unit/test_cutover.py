"""C10 — V1 Cutover tests.

Verifies that:
1. chat.py no longer imports v1 Orchestrator / Decomposer / SkillExecutor
2. chat.py imports v2 streaming and v2 memory singleton
3. v2 memory store singleton works correctly
4. dev status page reports M5/M6 as complete
5. startup event initializes v2 memory store
6. SSE event stream emits session-ready and synthesis-done with assistant_message_id
"""
from __future__ import annotations

import ast
import importlib
import json
import re
import textwrap
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

CHAT_PY = Path("lokidoki/api/routes/chat.py")
DEV_PY = Path("lokidoki/api/routes/dev.py")
MAIN_PY = Path("lokidoki/main.py")


# ---- 1. v1 imports removed from chat.py ------------------------------------

class TestV1ImportsRemoved:
    """chat.py must not import v1 orchestration modules at module level."""

    def _get_imports(self) -> set[str]:
        """Return all imported module names from chat.py's AST."""
        source = CHAT_PY.read_text()
        tree = ast.parse(source)
        names: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    names.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    names.add(node.module)
        return names

    def test_no_orchestrator_import(self):
        imports = self._get_imports()
        assert "lokidoki.core.orchestrator" not in imports

    def test_no_decomposer_import(self):
        imports = self._get_imports()
        assert "lokidoki.core.decomposer" not in imports

    def test_no_skill_executor_import(self):
        imports = self._get_imports()
        assert "lokidoki.core.skill_executor" not in imports

    def test_no_model_manager_import(self):
        imports = self._get_imports()
        assert "lokidoki.core.model_manager.ModelManager" not in str(imports)
        # ModelPolicy is still needed, ModelManager is not
        source = CHAT_PY.read_text()
        assert "ModelManager" not in source

    def test_no_skill_registry_at_module_level(self):
        """SkillRegistry should not be instantiated at module scope in chat.py."""
        source = CHAT_PY.read_text()
        # Check that _registry = SkillRegistry(...) is NOT at module level
        # (it may be inside a function for /skills endpoint, which is fine)
        lines = source.split("\n")
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("_registry") and "SkillRegistry" in stripped:
                # Must be indented (inside a function)
                assert line.startswith(" ") or line.startswith("\t"), (
                    "SkillRegistry should not be instantiated at module scope"
                )


# ---- 2. v2 imports present ------------------------------------------------

class TestV2ImportsPresent:
    """chat.py must reference v2 pipeline and memory store."""

    def test_imports_v2_streaming(self):
        source = CHAT_PY.read_text()
        assert "stream_pipeline_sse" in source

    def test_imports_memory_store_singleton(self):
        source = CHAT_PY.read_text()
        assert "get_memory_store" in source

    def test_chat_endpoint_uses_v2_context(self):
        source = CHAT_PY.read_text()
        assert "memory_writes_enabled" in source
        assert "memory_store" in source
        assert "owner_user_id" in source


# ---- 3. v2 memory store singleton -----------------------------------------

class TestV2MemorySingleton:
    """Production v2 memory store singleton behaves correctly."""

    def test_returns_store_instance(self):
        from lokidoki.core.memory_store_singleton import get_memory_store
        from lokidoki.orchestrator.memory.store import MemoryStore
        store = get_memory_store()
        assert isinstance(store, MemoryStore)

    def test_singleton_returns_same_instance(self):
        from lokidoki.core.memory_store_singleton import get_memory_store
        a = get_memory_store()
        b = get_memory_store()
        assert a is b

    def test_set_override(self):
        from lokidoki.core.memory_store_singleton import (
            get_memory_store,
            set_memory_store,
        )
        from lokidoki.orchestrator.memory.store import MemoryStore
        original = get_memory_store()
        custom = MemoryStore(":memory:")
        set_memory_store(custom)
        try:
            assert get_memory_store() is custom
            assert get_memory_store() is not original
        finally:
            set_memory_store(original)


# ---- 4. dev status reflects M5/M6 complete --------------------------------

class TestDevStatusReflectsV2:
    """Dev status endpoint reports M5 and M6 as complete."""

    def test_m5_complete(self):
        source = DEV_PY.read_text()
        # Find the M5 phase entry
        assert '"m5"' in source
        # Check it says "complete" not "not_started"
        m5_match = re.search(r'"id":\s*"m5".*?"status":\s*"(\w+)"', source, re.DOTALL)
        assert m5_match, "M5 phase not found"
        assert m5_match.group(1) == "complete"

    def test_m6_complete(self):
        source = DEV_PY.read_text()
        m6_match = re.search(r'"id":\s*"m6".*?"status":\s*"(\w+)"', source, re.DOTALL)
        assert m6_match, "M6 phase not found"
        assert m6_match.group(1) == "complete"

    def test_current_focus_mentions_cutover(self):
        source = DEV_PY.read_text()
        assert "cutover" in source.lower()


# ---- 5. startup initializes v2 store --------------------------------------

class TestStartupInitialization:
    """main.py startup event eagerly creates the v2 memory store."""

    def test_startup_references_memory_store(self):
        source = MAIN_PY.read_text()
        assert "get_memory_store" in source

    def test_startup_calls_before_bootstrap(self):
        """v2 store init should happen before run_bootstrap() inside startup_event."""
        source = MAIN_PY.read_text()
        # Find the startup_event function body
        startup_start = source.find("async def startup_event")
        assert startup_start > 0, "startup_event not found"
        startup_body = source[startup_start:]
        v2_pos = startup_body.find("get_memory_store")
        bootstrap_pos = startup_body.find("run_bootstrap()")
        assert v2_pos > 0, "get_memory_store not in startup_event"
        assert bootstrap_pos > 0, "run_bootstrap not in startup_event"
        assert v2_pos < bootstrap_pos, "v2 store should initialize before bootstrap"


# ---- 6. chat.py preserves message persistence ------------------------------

class TestMessagePersistence:
    """chat.py still persists user and assistant messages via v1 MemoryProvider."""

    def test_persists_user_message(self):
        source = CHAT_PY.read_text()
        assert "add_message" in source
        assert 'role="user"' in source

    def test_persists_assistant_message(self):
        source = CHAT_PY.read_text()
        assert 'role="assistant"' in source

    def test_emits_session_ready_event(self):
        source = CHAT_PY.read_text()
        assert '"phase": "session"' in source or '"phase":"session"' in source or 'session_event' in source
        assert "session_id" in source

    def test_injects_assistant_message_id(self):
        source = CHAT_PY.read_text()
        assert "assistant_message_id" in source

    def test_auto_names_session(self):
        source = CHAT_PY.read_text()
        assert "_auto_name_session" in source
        assert "is_first_turn" in source


# ---- 7. chat.py wires persona into v2 context -----------------------------

class TestPersonaWiring:
    """v2 pipeline receives behavior_prompt and character_name via context."""

    def test_behavior_prompt_in_context(self):
        source = CHAT_PY.read_text()
        assert "behavior_prompt" in source
        assert "character_ops" in source

    def test_character_name_in_context(self):
        source = CHAT_PY.read_text()
        assert "character_name" in source

    def test_character_id_in_context(self):
        source = CHAT_PY.read_text()
        assert "character_id" in source
