"""C07 gate tests — Skills Runtime Wiring.

Validates:
1. Dynamic handler map from registry (no hardcoded executor map)
2. Real adapter usage (LokiSmartHomeAdapter, not in-memory stub)
3. Skills receive params from NER pipeline (no chunk_text heuristics)
4. Source metadata surfaces end-to-end from direct-API skills
"""
from __future__ import annotations

import importlib

import pytest

from v2.orchestrator.execution.executor import (
    _BUILTIN_HANDLERS,
    _get_skill_handler_map,
    _resolve_handler,
    _echo_handler,
)
from v2.orchestrator.registry.loader import build_handler_map, load_function_registry


# ---- Gate 3: Runtime executes a skill without compile-time import -----------


class TestDynamicHandlerMap:
    """Handler map is built from function_registry.json, not hardcoded."""

    def test_handler_map_built_from_registry(self):
        """build_handler_map reads module_path/entry_point from registry."""
        hmap = build_handler_map()
        assert isinstance(hmap, dict)
        assert len(hmap) > 50, f"expected 50+ handlers, got {len(hmap)}"

    def test_handler_map_matches_registry_implementations(self):
        """Every implementation with module_path in the registry appears."""
        items = load_function_registry()
        expected: set[str] = set()
        for item in items:
            for impl in item.get("implementations") or []:
                if impl.get("module_path") and impl.get("entry_point"):
                    expected.add(impl["handler_name"])
        hmap = build_handler_map()
        assert expected == set(hmap), f"mismatch: {expected.symmetric_difference(set(hmap))}"

    def test_all_registry_handlers_importable_from_map(self):
        """Every handler in the dynamic map actually imports."""
        hmap = build_handler_map()
        failures: list[str] = []
        for handler_name, (module_path, attr_name) in hmap.items():
            try:
                module = importlib.import_module(module_path)
                if not hasattr(module, attr_name):
                    failures.append(f"{handler_name}: {module_path} missing '{attr_name}'")
            except ImportError as exc:
                failures.append(f"{handler_name}: import failed: {exc}")
        assert not failures, "\n".join(failures)

    def test_no_hardcoded_skill_handler_map_in_executor(self):
        """executor.py no longer has a module-level _SKILL_HANDLER_MAP dict."""
        import v2.orchestrator.execution.executor as executor_mod
        assert not hasattr(executor_mod, "_SKILL_HANDLER_MAP"), (
            "_SKILL_HANDLER_MAP still exists in executor.py — should use dynamic map"
        )

    def test_resolve_handler_finds_lazy_loaded_skill(self):
        """_resolve_handler loads a skill handler via the dynamic map."""
        handler = _resolve_handler("skills.weather.forecast")
        assert handler is not _echo_handler, "weather handler should not be echo"
        assert callable(handler)

    def test_resolve_handler_falls_back_for_unknown(self):
        """Unknown handler names fall back to echo, not crash."""
        handler = _resolve_handler("nonexistent.skill.xyz")
        assert handler is _echo_handler

    def test_adding_skill_only_needs_registry_entry(self):
        """A new registry entry with module_path/entry_point appears in map
        without any executor.py changes."""
        hmap = build_handler_map()
        # Verify at least one handler we know is in the registry
        assert "skills.weather.forecast" in hmap
        mod, attr = hmap["skills.weather.forecast"]
        assert mod == "v2.orchestrator.skills.weather"
        assert attr == "handle"


# ---- Gate 1: People, device, memory resolution use real adapters -----------


class TestRealAdapters:
    """Resolver uses LokiSmartHomeAdapter instead of hardcoded stub."""

    def test_resolver_uses_loki_smarthome_adapter_by_default(self):
        """resolve_chunks constructs LokiSmartHomeAdapter, not HomeAssistantAdapter."""
        import inspect
        from v2.orchestrator.resolution import resolver
        source = inspect.getsource(resolver.resolve_chunks)
        assert "LokiSmartHomeAdapter" in source
        assert "HomeAssistantAdapter()" not in source

    def test_resolver_accepts_injected_adapter_via_context(self):
        """Tests can inject a custom adapter via context['device_adapter']."""
        from v2.orchestrator.adapters.home_assistant import DeviceRecord, HomeAssistantAdapter
        from v2.orchestrator.core.types import ChunkExtraction, RequestChunk, RouteMatch
        from v2.orchestrator.resolution.resolver import resolve_chunks

        fake_devices = [
            DeviceRecord(
                entity_id="light.test_lamp",
                friendly_name="Test Lamp",
                domain="light",
                area="test",
                aliases=["test lamp", "the lamp"],
            ),
        ]
        adapter = HomeAssistantAdapter(devices=fake_devices)
        chunks = [RequestChunk(text="turn on the lamp", index=0, role="primary_request")]
        extractions = [ChunkExtraction(chunk_index=0, subject_candidates=["the lamp"])]
        routes = [RouteMatch(chunk_index=0, capability="control_device", confidence=1.0)]
        results = resolve_chunks(chunks, extractions, routes, context={"device_adapter": adapter})
        assert results[0].resolved_target == "Test Lamp"
        assert results[0].source == "home_assistant"

    def test_device_resolver_protocol_type(self):
        """device_resolver uses Protocol, not concrete HomeAssistantAdapter."""
        import inspect
        from v2.orchestrator.resolution import device_resolver
        source = inspect.getsource(device_resolver.resolve_device)
        assert "DeviceAdapter" in source


# ---- Gate 4: Skills don't need _extract_location fallbacks -----------------


class TestParamsFromPipeline:
    """Skills receive structured params from NER, not chunk_text heuristics."""

    def test_weather_reads_params_not_chunk_text(self):
        """Weather handler uses params['location'], not ' in ' heuristic."""
        import inspect
        from v2.orchestrator.skills import weather
        source = inspect.getsource(weather._extract_location)
        assert "chunk_text" not in source, "weather still parses chunk_text"
        assert "params" in source

    def test_time_in_location_reads_params_first(self):
        """time_in_location reads params['city'] and params['location']."""
        import inspect
        from v2.orchestrator.skills import time_in_location
        source = inspect.getsource(time_in_location._extract_city)
        assert 'params' in source

    def test_markets_reads_params_first(self):
        """Markets handler reads params['ticker'] first."""
        import inspect
        from v2.orchestrator.skills import markets
        source = inspect.getsource(markets._extract_ticker)
        assert "params" in source

    def test_people_facts_reads_params_person(self):
        """people_facts uses params['person'] from NER."""
        import inspect
        from v2.orchestrator.skills import people_facts
        source = inspect.getsource(people_facts.lookup_fact)
        assert "params" in source
        assert 'person' in source

    def test_derivations_cover_key_capabilities(self):
        """NER derivation map covers weather, stocks, time, showtimes."""
        from v2.orchestrator.pipeline.derivations import _CAPABILITY_PARAMS
        assert "get_weather" in _CAPABILITY_PARAMS
        assert "get_stock_price" in _CAPABILITY_PARAMS
        assert "get_stock_info" in _CAPABILITY_PARAMS
        assert "time_in_location" in _CAPABILITY_PARAMS
        assert "get_movie_showtimes" in _CAPABILITY_PARAMS
        assert "lookup_person_facts" in _CAPABILITY_PARAMS

    @pytest.mark.anyio
    async def test_weather_uses_param_location(self, monkeypatch):
        """Weather handler passes params['location'] to the mechanism."""
        from lokidoki.core.skill_executor import MechanismResult
        from v2.orchestrator.skills import weather as adapter

        class FakeSkill:
            def __init__(self):
                self.calls: list[tuple[str, dict]] = []

            async def execute_mechanism(self, method, params):
                self.calls.append((method, dict(params)))
                return MechanismResult(success=True, data={"lead": "Sunny in Paris."})

        fake = FakeSkill()
        monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

        await adapter.handle({"chunk_text": "weather", "params": {"location": "Paris"}})
        assert fake.calls[0][1]["location"] == "Paris"

    @pytest.mark.anyio
    async def test_weather_defaults_when_no_params(self, monkeypatch):
        """Without params, weather falls back to configured default."""
        from lokidoki.core.skill_executor import MechanismResult
        from v2.orchestrator.skills import weather as adapter

        class FakeSkill:
            def __init__(self):
                self.calls: list[tuple[str, dict]] = []

            async def execute_mechanism(self, method, params):
                self.calls.append((method, dict(params)))
                return MechanismResult(success=True, data={"lead": "Default area."})

        fake = FakeSkill()
        monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

        await adapter.handle({"chunk_text": "is it going to rain"})
        assert fake.calls[0][1]["location"] == "your area"


# ---- Gate 2: External skills surface sources metadata end-to-end -----------


class TestSourcePropagation:
    """Skills with external APIs set source_url/source_title."""

    def test_markets_sets_source_url(self):
        """markets.py AdapterResult includes Yahoo Finance source."""
        import inspect
        from v2.orchestrator.skills import markets
        source = inspect.getsource(markets.get_stock_price)
        assert "source_url" in source
        assert "finance.yahoo.com" in source

    def test_people_facts_sets_source_url(self):
        """people_facts.py AdapterResult includes Wikidata source."""
        import inspect
        from v2.orchestrator.skills import people_facts
        source = inspect.getsource(people_facts.lookup_fact)
        assert "source_url" in source
        assert "wikidata.org" in source

    def test_adapter_result_to_payload_includes_sources(self):
        """AdapterResult.to_payload() propagates source_url to sources list."""
        from v2.orchestrator.skills._runner import AdapterResult

        result = AdapterResult(
            output_text="test",
            source_url="https://example.com",
            source_title="Example",
        )
        payload = result.to_payload()
        assert payload["sources"] == [{"url": "https://example.com", "title": "Example"}]
