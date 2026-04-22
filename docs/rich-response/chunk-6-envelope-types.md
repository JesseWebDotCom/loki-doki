# Chunk 6 — `ResponseEnvelope` + `Block` backend dataclasses

## Goal

Define the canonical Python dataclasses for the new response contract: `ResponseEnvelope`, `Block`, `BlockState`, `BlockType`, plus the initial subclass/typed-dict shapes for the block families we'll use in Chunks 8–15 (`summary`, `sources`, `media`, `key_facts`, `steps`, `comparison`, `follow_ups`, `clarification`, `status`). This chunk ships the **types only** — the synthesizer still emits the legacy `ResponseObject.output_text`; Chunk 7 wires the envelope through the pipeline.

No frontend changes. No new SSE events yet.

## Files

- `lokidoki/orchestrator/response/__init__.py` — new package marker.
- `lokidoki/orchestrator/response/envelope.py` — new. `ResponseEnvelope`, `Hero`, top-level surfaces (`source_surface`, `artifact_surface`).
- `lokidoki/orchestrator/response/blocks.py` — new. `BlockState` enum, `BlockType` enum, `Block` base, typed block variants.
- `lokidoki/orchestrator/response/serde.py` — new. `envelope_to_dict(envelope)` + `envelope_from_dict(data)` for SSE/transport + SQLite persistence.
- `tests/unit/test_response_envelope.py` — new.

Read-only: `lokidoki/orchestrator/adapters/base.py`, `lokidoki/orchestrator/core/types.py`, `docs/lokidoki-rich-response-design.md` §11 / §12.

## Actions

1. **`BlockState` enum** (`lokidoki/orchestrator/response/blocks.py`):

   ```python
   class BlockState(str, Enum):
       loading = "loading"
       partial = "partial"
       ready = "ready"
       omitted = "omitted"
       failed = "failed"
   ```

2. **`BlockType` enum**:

   ```python
   class BlockType(str, Enum):
       summary = "summary"
       key_facts = "key_facts"
       steps = "steps"
       comparison = "comparison"
       sources = "sources"
       media = "media"
       cta_links = "cta_links"
       clarification = "clarification"
       follow_ups = "follow_ups"
       status = "status"
   ```

3. **`Block` base + typed variants**. Use a discriminated-union pattern with a base dataclass and per-type payload:

   ```python
   @dataclass
   class Block:
       id: str                          # stable id, e.g. "summary", "sources-1"
       type: BlockType
       state: BlockState = BlockState.loading
       seq: int = 0                     # monotonically increasing patch counter
       reason: str | None = None        # populated only when state == failed
       # payload fields by type
       content: str | None = None                     # summary, clarification, status
       items: list[dict] | None = None                # key_facts, steps, sources, media, cta_links, follow_ups
       comparison: dict | None = None                 # comparison: {"left": ..., "right": ..., "dimensions": [...]}
   ```

   Use a single `Block` class rather than a zoo of subclasses — the renderer will dispatch on `type`, and keeping one shape makes serde trivial.

4. **`Hero`** (optional top-of-turn display):

   ```python
   @dataclass
   class Hero:
       title: str
       subtitle: str | None = None
       image_url: str | None = None     # must be local (bootstrap-materialized) — runtime check lives in Chunk 11
   ```

5. **`ResponseEnvelope`** (`lokidoki/orchestrator/response/envelope.py`):

   ```python
   @dataclass
   class ResponseEnvelope:
       request_id: str
       mode: Literal["direct", "standard", "rich", "deep", "search", "artifact"] = "standard"
       status: Literal["streaming", "complete", "failed"] = "streaming"
       hero: Hero | None = None
       blocks: list[Block] = field(default_factory=list)
       source_surface: list[dict] = field(default_factory=list)     # reuses shared Source model serialized shape
       artifact_surface: dict | None = None                         # populated only in artifact mode
       spoken_text: str | None = None
   ```

6. **Serde** (`response/serde.py`):
   - `envelope_to_dict(envelope: ResponseEnvelope) -> dict` — plain JSON-compatible, enums serialize to strings.
   - `envelope_from_dict(data: dict) -> ResponseEnvelope` — inverse. Unknown block types raise `ValueError` rather than silently dropping.
   - Round-trip invariant test: `envelope_from_dict(envelope_to_dict(e)) == e` for a fixture covering every block type.

7. **Validation helpers** (same file):
   - `validate_envelope(envelope)` — checks: unique block ids; `seq` monotonic within a block id; at most one `summary` block; at most one `sources` block; block count ≤ 8.
   - Raise `EnvelopeValidationError` with the specific rule violated.

8. **Tests** (`tests/unit/test_response_envelope.py`):
   - Construct an envelope with summary + sources + media blocks; assert `validate_envelope` passes.
   - Construct two summary blocks → assert it raises.
   - Construct 9 blocks → assert it raises.
   - Non-monotonic seq → assert it raises.
   - Round-trip serde for every `BlockType`.
   - `state == failed` requires `reason` to be non-None (enforce this in `validate_envelope`).

9. **No consumer wiring yet**. The synthesizer still returns `ResponseObject(output_text=...)`; nothing creates a `ResponseEnvelope` in this chunk. Chunk 7 does that.

## Verify

```
pytest tests/unit/test_response_envelope.py -v && pytest tests/unit/test_streaming.py tests/unit/test_synthesis.py -v
```

New tests pass; existing tests still pass (nothing wired yet).

## Commit message

```
feat(response): ResponseEnvelope + Block dataclasses

Introduce the canonical types for the rich-response contract:
ResponseEnvelope, Hero, Block (single class, type-discriminated),
BlockType, BlockState, plus serde + validation. No consumer wiring
yet — chunk 7 plumbs synthesis through the envelope alongside the
legacy output_text path.

Refs docs/rich-response/PLAN.md chunk 6.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
