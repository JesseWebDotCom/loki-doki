"""Memory read/write path integration for the pipeline."""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.core.types import ParsedInput
from lokidoki.orchestrator.memory.extractor import ExtractionContext, extract_candidates
from lokidoki.orchestrator.memory.slots import assemble_slots
from lokidoki.orchestrator.memory.store import MemoryStore
from lokidoki.orchestrator.memory.writer import WriteRunResult, process_candidates


def run_memory_read_path(
    raw_text: str,
    safe_context: dict[str, Any],
) -> dict[str, str]:
    """Lazy memory read step (M2 + M3 + M4 + M5 + M6).

    Delegates to ``assemble_slots`` which gates each tier slot on its
    own ``need_*`` flag. Returns only non-empty slots.
    """
    store = safe_context.get("memory_store")
    if not isinstance(store, MemoryStore):
        return {}
    # assemble_slots reads need_* flags and query from context
    safe_context.setdefault("user_input", raw_text)
    safe_context.setdefault("memory_query", raw_text)
    all_slots = assemble_slots(safe_context)
    return {k: v for k, v in all_slots.items() if v}


def run_memory_write_path(
    parsed: ParsedInput,
    chunks: list,
    safe_context: dict[str, Any],
) -> WriteRunResult:
    """Run the M1 write path on the current turn.

    Memory writes are opt-in via ``context["memory_writes_enabled"]``
    or ``context["memory_store"]``.
    """
    enabled = bool(safe_context.get("memory_writes_enabled"))
    custom_store = safe_context.get("memory_store")
    if not enabled and custom_store is None:
        return WriteRunResult()
    parse_doc = getattr(parsed, "doc", None)
    if parse_doc is None:
        return WriteRunResult()
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    decomposed_intent = safe_context.get("decomposed_intent")
    resolved_people = safe_context.get("resolved_people") or []
    known_entities = safe_context.get("known_entities") or []
    aggregate = WriteRunResult()
    for chunk in chunks:
        if chunk.role != "primary_request":
            continue
        ext_context = ExtractionContext(
            owner_user_id=owner_user_id,
            chunk_index=chunk.index,
            source_text=chunk.text,
        )
        candidates = extract_candidates(parse_doc, context=ext_context)
        if not candidates:
            continue
        run = process_candidates(
            candidates,
            parse_doc=parse_doc,
            resolved_people=resolved_people,
            known_entities=known_entities,
            decomposed_intent=decomposed_intent,
            store=custom_store,
        )
        aggregate.accepted.extend(run.accepted)
        aggregate.rejected.extend(run.rejected)
    return aggregate
