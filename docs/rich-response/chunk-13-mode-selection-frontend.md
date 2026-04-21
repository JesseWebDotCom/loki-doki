# Chunk 13 — Mode toggle UI + `/deep` slash command

## Goal

Expose mode selection to the user. Add a compact mode toggle in the compose bar (auto / rich / deep / search) plus a `/deep`, `/search`, `/rich` slash-command parser so voice-first and keyboard-first users both have explicit control. The override flows to the backend as the `user_override` parameter wired in Chunk 12.

## Files

- `frontend/src/components/chat/ModeToggle.tsx` — new.
- `frontend/src/components/chat/SlashCommandParser.ts` — new. Pure function: `parseSlash(input) -> { override: Mode | null, cleanedInput: string }`.
- `frontend/src/components/chat/ComposeBar.tsx` — edit (or whichever component currently owns the input + send). Mount `ModeToggle`; run input through `parseSlash` before submitting.
- `frontend/src/lib/api.ts` — extend the chat-send call to include `user_mode_override` in the request body when set.
- `lokidoki/api/routes/chat.py` — accept and pass `user_mode_override` into the pipeline context.
- `lokidoki/orchestrator/core/pipeline.py` — thread `user_mode_override` into the context consumed by Chunk 12's `derive_response_mode`.
- `frontend/src/components/chat/__tests__/slash-parser.test.ts` — new.
- `tests/unit/test_user_mode_override.py` — new.

Read-only: Chunk 12's `derive_response_mode`, compose bar's existing structure.

## Actions

1. **`ModeToggle`** — shadcn/ui `ToggleGroup` with four items:
   - `auto` (default — no override, backend derives)
   - `rich`
   - `deep` (shows a warning tooltip about longer latency; voice users confirm via spoken `/deep`)
   - `search`
   Not a "chat/search mode selector" that hides inputs — this is a one-line compact group.

2. **Slash parser**:
   - `parseSlash("/deep ... rest of prompt")` → `{ override: "deep", cleanedInput: "... rest of prompt" }`.
   - Supported prefixes: `/direct`, `/standard`, `/rich`, `/deep`, `/search`.
   - Prefix must be at message start and followed by a space.
   - Unknown slash prefixes pass through unchanged (don't eat `/` in general user text).
   - Case-insensitive on the prefix itself (`/Deep` works). No regex scanning of the whole input — string `startsWith` is sufficient and not an intent classifier (this is command parsing, which the CLAUDE.md rule explicitly permits).

3. **Compose bar wiring**:
   - Before send, run `parseSlash(inputValue)`. If an override was parsed, use it; else use the `ModeToggle` value.
   - Pass the resolved `user_mode_override` (or `null` for `auto`) into the send payload.
   - On send, reset the toggle to `auto` **only** if the user had used a slash command (slash is a per-turn override; the toggle is sticky).

4. **Backend plumbing**:
   - `chat.py` accepts `user_mode_override: str | None` in the POST body.
   - Validate it against the known mode literal set; reject unknown values with 400 (not a silent drop — the user explicitly asked for something).
   - Thread into the pipeline context so Chunk 12's `derive_response_mode` receives it.

5. **UX polish**:
   - Mode toggle is part of the compose bar, not a modal or side menu.
   - Deep mode click shows a lightweight shadcn `Popover` once per session explaining "this may take up to 90 s on Pi; progress appears as it runs."
   - Touch targets meet Onyx Material spec (44px min for the toggle group on touch).

6. **Voice-first trigger**:
   - If the user's spoken input (transcribed via STT before reaching chat) begins with "deep" followed by the prompt, treat it identically to `/deep`. This handoff happens inside `SlashCommandParser` — the STT layer can prepend `/deep` to the transcribed text, or the parser can accept a non-slash variant with a bounded word list (`deep`, `search`). Prefer the STT-prepends-slash approach because it keeps the parser a pure command interpreter, not an NLU pass.

7. **Tests**:
   - `slash-parser.test.ts`: exhaustive cases + pass-through for non-command inputs.
   - Backend: POST with `user_mode_override="deep"` lands at `derive_response_mode` and returns an envelope with `mode="deep"`.
   - Unknown override returns 400 with a clear message.

## Verify

```
npm --prefix frontend run test -- slash-parser && npm --prefix frontend run build && pytest tests/unit/test_user_mode_override.py tests/unit/test_response_mode.py -v
```

All tests pass. Manual: type `/deep tell me about ...` → the backend receives the override, the envelope returns `mode="deep"`, the UI renders the deep-work frame skeleton.

## Commit message

```
feat(chat): mode toggle + slash-command override

Add a compact compose-bar ModeToggle (auto / rich / deep / search)
and a /deep|/search|/rich slash parser. The resolved override
flows to the backend as user_mode_override and wins over
derive_response_mode's automatic derivation.

Slash parsing is a startsWith check at the message head — not a
regex NLU pass over user text. Voice users get the same override
via STT-prepended slashes.

Refs docs/rich-response/PLAN.md chunk 13.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
