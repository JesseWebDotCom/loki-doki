# Chunk 8 — Frontend block registry + summary/sources/media renderers

## Goal

Build the frontend-side block abstraction that later chunks expand. Introduce a **block registry** keyed by `BlockType` that returns the renderer component for each block. Port today's inline-text / sources-panel / media-bar behavior into three block renderers (`SummaryBlock`, `SourcesBlock`, `MediaBlock`) without changing observable behavior — the existing SSE path still drives rendering. No new event wiring yet (Chunk 10 does that).

After this chunk: `MessageItem` composes blocks by iterating a list and dispatching via the registry instead of hard-coding three branches.

## Files

- `frontend/src/lib/response-types.ts` — new. TypeScript mirror of the backend `ResponseEnvelope` / `Block` / `BlockType` / `BlockState`.
- `frontend/src/components/chat/blocks/index.ts` — new. Block registry.
- `frontend/src/components/chat/blocks/SummaryBlock.tsx` — new.
- `frontend/src/components/chat/blocks/SourcesBlock.tsx` — new.
- `frontend/src/components/chat/blocks/MediaBlock.tsx` — new.
- `frontend/src/components/chat/blocks/BlockShell.tsx` — new. Common skeleton + state handling (loading / partial / ready / failed).
- `frontend/src/components/chat/MessageItem.tsx` — edit to compose from blocks using the registry.
- `frontend/src/components/chat/__tests__/blocks.test.tsx` — new vitest tests.

Read-only: `frontend/src/lib/api-types.ts`, existing `SourcesPanel.tsx`, `MediaBar.tsx`.

## Actions

1. **TS mirror types** (`response-types.ts`). Keep field names identical to the Python dataclasses for straight deserialization:

   ```ts
   export type BlockState = "loading" | "partial" | "ready" | "omitted" | "failed";
   export type BlockType = "summary" | "key_facts" | "steps" | "comparison" |
                           "sources" | "media" | "cta_links" | "clarification" |
                           "follow_ups" | "status";

   export interface Block {
     id: string;
     type: BlockType;
     state: BlockState;
     seq: number;
     reason?: string;
     content?: string;
     items?: any[];
     comparison?: { left: any; right: any; dimensions: string[] };
   }

   export interface ResponseEnvelope {
     request_id: string;
     mode: "direct" | "standard" | "rich" | "deep" | "search" | "artifact";
     status: "streaming" | "complete" | "failed";
     hero?: { title: string; subtitle?: string; image_url?: string };
     blocks: Block[];
     source_surface: any[];
     artifact_surface?: any;
     spoken_text?: string;
   }
   ```

2. **BlockShell** — uses shadcn/ui primitives (`Card`, `Skeleton`). Renders loading skeleton for `loading`/`partial`, the child for `ready`, a muted failure chip for `failed` with `reason`. No raw `<div>` styling beyond what shadcn already provides. Must obey Onyx Material elevation rules (Level 1–2 for blocks).

3. **Block registry** (`blocks/index.ts`):

   ```ts
   import { SummaryBlock } from "./SummaryBlock";
   import { SourcesBlock } from "./SourcesBlock";
   import { MediaBlock } from "./MediaBlock";

   export const BLOCK_REGISTRY: Partial<Record<BlockType, React.FC<{ block: Block }>>> = {
     summary: SummaryBlock,
     sources: SourcesBlock,
     media: MediaBlock,
   };

   export function renderBlock(block: Block): React.ReactNode {
     const C = BLOCK_REGISTRY[block.type];
     if (!C) return null;          // unknown type: silently skip (chunk 14/15 fill the rest)
     return <C key={block.id} block={block} />;
   }
   ```

4. **`SummaryBlock`** — renders `block.content` as markdown (use the markdown renderer already in `MessageItem.tsx`, do not introduce a new dep). Delegates state chrome to `BlockShell`.

5. **`SourcesBlock`** — wraps today's `SourceChip` row behavior; `block.items` is a `Source[]` shape. The inline chip row renders here; the richer `SourcesPanel` side drawer stays driven by the envelope's `source_surface` (wired in Chunk 11). Do NOT delete `SourcesPanel.tsx` in this chunk.

6. **`MediaBlock`** — wraps today's `MediaBar` logic; `block.items` is the existing `MediaCard[]` discriminated union. Preserve current behavior exactly (YouTube cards, channel cards, scroll layout).

7. **MessageItem refactor**:
   - Derive a `blocks: Block[]` from the existing `SynthesisData` payload client-side for now (until Chunk 10 consumes the envelope from the wire). Build it with:
     - one `summary` block with `content = synthesis.response`, `state = "ready"`.
     - one `sources` block with `items = synthesis.sources ?? []`, `state = "ready" | "omitted"`.
     - one `media` block with `items = synthesis.media ?? []`, `state = "ready" | "omitted"`.
   - Replace the three hard-coded render branches with `blocks.map(renderBlock)`.
   - Keep the existing streaming/interim text path intact — the summary block can accept a streaming content update from the same source today.
   - Preserve `ThinkingIndicator` and `PipelineInfoPopover` — unchanged.

8. **Tests** (vitest + React Testing Library pattern already in repo):
   - Render `SummaryBlock` with a `ready` block → content visible.
   - Render `SummaryBlock` with `loading` → skeleton visible.
   - Render `SourcesBlock` with 0 items + `state="omitted"` → renders nothing (doesn't crash).
   - Render `MessageItem` with a `SynthesisData` payload → exactly one summary + optional sources + optional media, matching the current pixel behavior.

## Verify

```
npm --prefix frontend run test -- blocks && npm --prefix frontend run build
```

Tests pass. Build succeeds. Manual smoke test: run `./run.sh`, send a calculator query; the rendered bubble matches today's look (the refactor is intentionally invisible).

## Commit message

```
refactor(chat): block registry + summary/sources/media renderers

MessageItem now composes its output by iterating a list of Blocks
and dispatching via BLOCK_REGISTRY instead of hard-coding three
branches. Behavior is unchanged — blocks are derived client-side
from the existing SynthesisData payload. Chunk 10 switches the
source of truth to the response envelope streamed from the
backend.

This is the foundation for every future block type.

Refs docs/rich-response/PLAN.md chunk 8.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->

- Chunk 8 added two shadcn primitives (`frontend/src/components/ui/card.tsx`, `frontend/src/components/ui/skeleton.tsx`) because the repo did not ship them yet and `BlockShell` / future block cards require them. Pure-React files, no new dependency added. Chunks 14/15 will consume `Card` when wrapping richer block types.
- `SourcesBlock` currently renders a visually-empty structural marker (`data-slot="sources-block"`) rather than an inline chip row. Current UX already surfaces sources two ways — inline `SourceChip`s inside the summary markdown and the side-drawer `SourcesPanel` opened from the action bar — and chunk 8's contract is "refactor is intentionally invisible." Chunk 11 (`SourceSurface + structured citations + offline trust chip`) replaces the marker with the real inline surface.
- Pre-existing test failures in `chatDensity.test.tsx` (asserts `px-7`/`py-5` on the assistant bubble — the assistant bubble has never carried those classes) and `MessageItem.test.tsx` (relies on DOM shape chunks 6/7 already changed) were left alone. They existed on `main` before chunk 8 started and are out of scope; they will be rewritten against the envelope-driven render in chunk 10.
- Per-block `{ block }`-only renderer signature cannot carry envelope-adjacent state (sources, mentioned people) that today's inline citations need. Added a small `BlockContext` inside `blocks/index.ts` for this; chunk 11 can graduate it to full envelope context if richer needs appear.
- Intentionally did not create a shared `AssistantMarkdown` helper to avoid touching a file outside the chunk's `## Files` list; the markdown render config is duplicated between `MessageItem.tsx` (user branch) and `blocks/SummaryBlock.tsx` (assistant branch). If a future chunk needs to edit markdown rendering in one place, consolidate then.
