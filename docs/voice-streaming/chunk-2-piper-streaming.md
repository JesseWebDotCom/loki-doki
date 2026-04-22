# Chunk 2 — Piper incremental-synthesis backend endpoint

## Goal

Expose a per-utterance streaming synth endpoint (`POST /api/v1/audio/tts/stream`) that takes a short text (one sentence/clause), runs Piper synchronously, and streams back ndjson PCM chunks + `final` marker. If the endpoint already exists for the one-shot path, extend it to accept a new short-utterance shape without regressing existing callers.

## Files

Touch (extend or create):
- `lokidoki/providers/tts/piper.py` (or existing Piper module — locate via `rg -n "piper" lokidoki/providers lokidoki/api`)
- `lokidoki/api/tts.py` (or wherever `/audio/tts/stream` is registered — locate via `rg -n "audio/tts" lokidoki`)
- `tests/unit/test_tts_streaming.py` (new)

Read-only reference:
- `frontend/src/utils/VoiceStreamer.ts` (ndjson consumer shape)
- `lokidoki/bootstrap/preflight/piper_runtime.py` (voice layout)

## Actions

1. Locate existing Piper integration and the `/api/v1/audio/tts/stream` endpoint. If the endpoint already streams PCM ndjson, audit that it accepts a short-text single-utterance request without chunking input further.
2. Add an `utterance_id: str` field to the request body (FastAPI/Pydantic model). Echo it back in every ndjson chunk so the frontend can correlate queue entries to the stream.
3. Ensure each request opens a fresh Piper synth session (no cross-request state). Piper is in-process via `piper-tts`; no subprocess teardown cost.
4. Keep the existing chunk size (audio frame cadence) — don't re-tune.
5. Add `final: bool` on the last ndjson line (if not already present) so the frontend knows when to close the reader cleanly.
6. Respect the Hard Rule: CPU-only synth. No Hailo path. No remote fallback.
7. Add a pytest under `tests/unit/test_tts_streaming.py`: boot the FastAPI test client, POST a short sentence, assert ≥1 ndjson line received, last line has `final: true`, PCM base64 decodes to non-empty bytes.
8. Do NOT change the one-shot callers (chunk 16). The existing `VoiceStreamer.stream(text)` call in the frontend must continue to work unchanged.

## Verify

```
uv run pytest tests/unit/test_tts_streaming.py -v
```

Manual: `./run.sh`, then `curl -N -X POST http://localhost:PORT/api/v1/audio/tts/stream -H 'Content-Type: application/json' -d '{"text":"Hello world.","voice":"en_US-lessac-medium","utterance_id":"t1"}' | head -5` — expect ndjson lines with `pcm` base64 payloads.

## Commit message

```
feat(tts): per-utterance Piper streaming endpoint

Extends /api/v1/audio/tts/stream to accept a short-text single
utterance with an utterance_id echoed on every ndjson chunk and a
final=true marker on close. Reuses the existing VoiceStreamer ndjson
shape; CPU-only Piper on all profiles; one-shot callers unchanged.

Refs docs/voice-streaming/PLAN.md chunk 2.
```

## Deferrals

(append-only)
