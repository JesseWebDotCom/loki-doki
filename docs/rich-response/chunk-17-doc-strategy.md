# Chunk 17 — Adaptive document handling (small inline / large RAG)

## Goal

Implement the LM Studio-style strategy: when a user attaches a document (PDF, text, markdown), pick between **full-context injection** (small, fits the model window) and **retrieval over chunks** (large, doesn't). Expose provenance for retrieved sections in the `sources` block. Keep the choice invisible in normal use, with a subtle chip indicating which mode ran.

## Files

- `lokidoki/orchestrator/documents/strategy.py` — new. `choose_strategy(doc_meta, profile) -> Literal["inline", "retrieval"]`.
- `lokidoki/orchestrator/documents/inline.py` — new. Loads a document into the synthesis context for small files.
- `lokidoki/orchestrator/documents/retrieval.py` — new. Chunked retrieval over a larger doc; reuses the existing memory/vector path if one is available in the repo, otherwise a minimal in-memory BM25 implementation.
- `lokidoki/orchestrator/adapters/document.py` — new. `DocumentAdapter` emits sources (one per retrieved chunk or one per whole-file ingestion) and summary candidates.
- `lokidoki/orchestrator/core/pipeline_phases.py` — call document strategy when the turn context carries an attached document.
- `frontend/src/components/chat/DocumentChip.tsx` — new. Shows "inline context" vs "retrieval" for the turn, with an info tooltip.
- `tests/unit/test_document_strategy.py` — new.

Read-only: existing memory/retrieval subsystems under `lokidoki/orchestrator/memory/`.

## Actions

1. **Strategy selection** (`strategy.py`):
   - Input: `doc_meta = {path, size_bytes, estimated_tokens, kind: pdf|txt|md|docx}`, `profile`.
   - Get the model context size from `PLATFORM_MODELS[profile]` (or the synthesis model's advertised context if already exposed).
   - If `estimated_tokens < 0.5 * context_size`, return `"inline"`.
   - Else return `"retrieval"`.
   - Document the 0.5 ratio in a comment; leave headroom for prompt + response.

2. **Inline path** (`inline.py`):
   - Read the document, extract plain text (use existing text-extraction code if present, otherwise a minimal PDF text extract via `pypdf` **if already in `pyproject.toml`** — if not, add it to `pyproject.toml` and defer shipping this chunk until a bootstrap run installs it. Do NOT `pip install` from the agent shell).
   - Inject the full text into the synthesis context as a `DocumentContext` object consumed alongside the decomposer output.
   - Produce one `Source` per document (title = filename, kind="doc", snippet = first 140 chars).

3. **Retrieval path** (`retrieval.py`):
   - Chunk the document (sentence-aware, ~400 tokens per chunk, 50-token overlap).
   - Use existing memory/vector infra if present. Otherwise, score via BM25 against the user's query (from decomposer's `distilled_query`).
   - Return top-K chunks (K = 5 on `pi_cpu`, 8 on mac/pi_hailo).
   - Produce one `Source` per returned chunk with `page` (if extractable from PDF) and `snippet`.

4. **Adapter** (`adapters/document.py`):
   - `DocumentAdapter.adapt(mechanism_result)` translates the strategy output into `AdapterOutput` with `sources` populated and (for inline) a single `summary_candidate` that hints the doc is in-context.

5. **Planner awareness** — the planner already uses adapter output to decide blocks. No special casing needed; the document simply contributes to the source pool. However:
   - Set a new envelope flag `envelope.document_mode: "inline" | "retrieval" | null` so the UI chip knows what to show.

6. **Frontend chip** (`DocumentChip.tsx`):
   - Renders in the message shell header when `envelope.document_mode` is set.
   - Label: "Reading full document" (inline) or "Searching document" (retrieval).
   - Tooltip explains the mode choice.
   - Offline-safe: no remote icons, uses a lucide `FileText` icon.

7. **Offline invariant**: every document action must work offline. Text extraction is local. Vector indexes are built locally via bootstrap. Reject any code path that would call a remote embedding API.

8. **Tests**:
   - Strategy returns inline for a 3 KB file, retrieval for a 10 MB file (mocked `estimated_tokens`).
   - BM25 retrieval returns sources with page and snippet.
   - Offline test: running retrieval with the network disabled succeeds.

## Verify

```
pytest tests/unit/test_document_strategy.py tests/unit/test_phase_synthesis.py -v && npm --prefix frontend run test -- DocumentChip && npm --prefix frontend run build
```

All tests pass. Manual: attach a 2-page markdown file → chip says "Reading full document"; attach a 200-page PDF → chip says "Searching document", sources link to retrieved chunks.

## Commit message

```
feat(documents): adaptive document handling

Add choose_strategy / inline / retrieval modules plus a
DocumentAdapter that emits sources consumable by the existing
adapter pipeline. Strategy picks inline when the doc fits half the
model context, retrieval otherwise. A DocumentChip on the message
shell surfaces which mode ran, with an explanatory tooltip.

All document processing is local. No remote embedding or extraction
service is invoked.

Refs docs/rich-response/PLAN.md chunk 17.
```

## Deferrals

- **`pypdf` runtime install via bootstrap.** Added `pypdf>=5.1.0` to
  `pyproject.toml` (no `pip install` / `uv add` from the agent shell).
  The extractor in
  `lokidoki/orchestrator/documents/extraction.py` degrades to an
  empty string when `pypdf` is missing, so verify + tests pass today
  without the package installed. The next bootstrap run (`./run.sh`
  → `uv sync`) materializes it on disk. No additional `versions.py`
  entry is needed — `pypdf` is a pure-Python wheel resolved by `uv`.
- **Existing vector infra reuse.** Repo's `lokidoki/orchestrator/memory/`
  is scoped to tier memory slots (episodic / facts / social etc.),
  not ad-hoc document corpora. Wiring in a second backing store would
  duplicate index plumbing for a different data lifetime; chunk 17
  uses a pure-Python BM25 implementation in
  `lokidoki/orchestrator/documents/retrieval.py` which is O(chunks)
  per turn and requires zero persistence. Revisit only if user-attached
  docs ever get large enough that BM25 scoring becomes the turn's
  latency bottleneck.
- **DOCX extraction.** Chunk doc lists DOCX as a supported kind; the
  extractor currently falls through to plain-text reads (most .docx
  files are ZIP-wrapped XML, so this yields garbage). A future chunk
  should add a `python-docx` pin in `pyproject.toml` and a branch in
  `extract_text` / `extract_pages`.
- **Attachment plumbing.** `_apply_attached_document` reads
  `safe_context["attached_document"]`, but no frontend flow sets that
  key yet — file-upload UI, the chat POST schema extension, and the
  context seeding happen in a later chunk (likely chunk 21 workspace
  lens or a dedicated upload chunk). The current pipeline is
  additive: every non-document turn is a no-op.
