/**
 * Pure reducer for the rich-response SSE event family (chunk 10).
 *
 * Mirrors the backend event names emitted by
 * ``lokidoki/orchestrator/response/events.py``:
 *
 *   response_init / block_init / block_patch / block_ready /
 *   block_failed / source_add / media_add / response_snapshot /
 *   response_done
 *
 * Given the previous envelope (or ``undefined`` before the turn
 * started) and the next ``PipelineEvent``, ``reduceResponse`` returns
 * the next envelope. No side effects — the caller owns React state,
 * persistence, and timing marks.
 *
 * Key invariants:
 *
 *   * The reducer is tolerant. Unknown event phases are no-ops so the
 *     existing pipeline-phase events (``augmentation`` / ``routing`` /
 *     ``synthesis`` / ...) flow through untouched.
 *   * ``seq`` guards: incoming ``seq <= last-applied seq`` for a block
 *     is dropped silently (idempotent replay).
 *   * ``response_snapshot`` fully replaces envelope state. Any deltas
 *     that somehow arrive after a snapshot are still applied, but the
 *     snapshot wins for everything it names. Chunk 9 enforces ordering
 *     on the wire so this is a belt-and-suspenders clause.
 */
import type { PipelineEvent } from "./api-types";
import {
  type Block,
  type BlockState,
  type BlockType,
  type EnvelopeMode,
  type ResponseEnvelope,
  envelopeFromDict,
} from "./response-types";

// ---------------------------------------------------------------------------
// Event-phase constants (match lokidoki/orchestrator/response/events.py)
// ---------------------------------------------------------------------------

export const RESPONSE_INIT = "response_init";
export const BLOCK_INIT = "block_init";
export const BLOCK_PATCH = "block_patch";
export const BLOCK_READY = "block_ready";
export const BLOCK_FAILED = "block_failed";
export const SOURCE_ADD = "source_add";
export const MEDIA_ADD = "media_add";
export const RESPONSE_SNAPSHOT = "response_snapshot";
export const RESPONSE_DONE = "response_done";

/** Convenience list for callers that want to detect "is this a
 *  response-family event?" before routing through the reducer. */
export const RESPONSE_EVENT_PHASES: readonly string[] = [
  RESPONSE_INIT,
  BLOCK_INIT,
  BLOCK_PATCH,
  BLOCK_READY,
  BLOCK_FAILED,
  SOURCE_ADD,
  MEDIA_ADD,
  RESPONSE_SNAPSHOT,
  RESPONSE_DONE,
];

export function isResponseEvent(ev: PipelineEvent): boolean {
  return RESPONSE_EVENT_PHASES.includes(ev.phase);
}

// ---------------------------------------------------------------------------
// Helpers — each returns a new envelope; no in-place mutation
// ---------------------------------------------------------------------------

function emptyEnvelope(request_id: string, mode: EnvelopeMode): ResponseEnvelope {
  return {
    request_id,
    mode,
    status: "streaming",
    blocks: [],
    source_surface: [],
  };
}

function initEnvelope(data: {
  request_id?: string;
  mode?: string;
  blocks?: Array<{ id: string; type: string }>;
}): ResponseEnvelope {
  const request_id = String(data.request_id ?? "");
  const mode = (data.mode ?? "standard") as EnvelopeMode;
  const blocks: Block[] = (data.blocks ?? []).map((stub) => ({
    id: String(stub.id),
    type: stub.type as BlockType,
    state: "loading" as BlockState,
    seq: 0,
  }));
  return {
    request_id,
    mode,
    status: "streaming",
    blocks,
    source_surface: [],
  };
}

function upsertBlock(
  env: ResponseEnvelope,
  data: { block_id?: string; type?: string; state?: string },
): ResponseEnvelope {
  const id = String(data.block_id ?? "");
  if (!id) return env;
  const state = (data.state as BlockState | undefined) ?? "loading";
  const idx = env.blocks.findIndex((b) => b.id === id);
  if (idx >= 0) {
    const next = [...env.blocks];
    next[idx] = { ...next[idx], state };
    return { ...env, blocks: next };
  }
  const block: Block = {
    id,
    type: (data.type as BlockType) ?? ("summary" as BlockType),
    state,
    seq: 0,
  };
  return { ...env, blocks: [...env.blocks, block] };
}

function patchBlock(
  env: ResponseEnvelope,
  data: {
    block_id?: string;
    seq?: number;
    delta?: string;
    items_delta?: unknown[];
  },
): ResponseEnvelope {
  const id = String(data.block_id ?? "");
  if (!id) return env;
  const idx = env.blocks.findIndex((b) => b.id === id);
  // Patches may arrive before ``block_init`` if the backend reorders —
  // create a loading shell so the delta is not lost.
  const existing: Block =
    idx >= 0
      ? env.blocks[idx]
      : {
          id,
          type: "summary" as BlockType,
          state: "loading" as BlockState,
          seq: 0,
        };
  const incomingSeq = typeof data.seq === "number" ? data.seq : 0;
  // Idempotent-replay guard: drop patches whose seq is not strictly
  // greater than the last applied. ``seq === 0`` on a fresh block
  // always applies because existing.seq starts at 0.
  if (existing.seq > 0 && incomingSeq <= existing.seq) {
    return env;
  }
  let content = existing.content;
  let items = existing.items;
  if (typeof data.delta === "string") {
    content = (content ?? "") + data.delta;
  }
  if (Array.isArray(data.items_delta)) {
    items = [...(items ?? []), ...data.items_delta];
  }
  // Flip loading -> partial on first patch; leave ready / partial alone.
  const state: BlockState =
    existing.state === "loading" ? "partial" : existing.state;
  const nextBlock: Block = {
    ...existing,
    state,
    seq: incomingSeq,
    content,
    items,
  };
  const nextBlocks =
    idx >= 0
      ? env.blocks.map((b, i) => (i === idx ? nextBlock : b))
      : [...env.blocks, nextBlock];
  return { ...env, blocks: nextBlocks };
}

function setBlockState(
  env: ResponseEnvelope,
  blockId: string,
  state: BlockState,
  reason?: string,
): ResponseEnvelope {
  const idx = env.blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) return env;
  const next = [...env.blocks];
  next[idx] = {
    ...next[idx],
    state,
    reason: reason ?? next[idx].reason,
  };
  return { ...env, blocks: next };
}

function appendSource(
  env: ResponseEnvelope,
  source: Record<string, unknown>,
): ResponseEnvelope {
  return {
    ...env,
    source_surface: [...env.source_surface, source],
  };
}

function appendMedia(
  env: ResponseEnvelope,
  media: Record<string, unknown>,
): ResponseEnvelope {
  // Locate (or allocate) the media block and append to its items.
  const idx = env.blocks.findIndex((b) => b.type === "media");
  if (idx < 0) {
    const mediaBlock: Block = {
      id: "media",
      type: "media",
      state: "partial",
      seq: 0,
      items: [media],
    };
    return { ...env, blocks: [...env.blocks, mediaBlock] };
  }
  const existing = env.blocks[idx];
  const next = [...env.blocks];
  next[idx] = {
    ...existing,
    state: existing.state === "loading" ? "partial" : existing.state,
    items: [...(existing.items ?? []), media],
  };
  return { ...env, blocks: next };
}

function blocksEquivalent(a: Block, b: Block): boolean {
  if (a.id !== b.id || a.type !== b.type) return false;
  if (String(a.content ?? "") !== String(b.content ?? "")) return false;
  const aItems = a.items ?? [];
  const bItems = b.items ?? [];
  if (aItems.length !== bItems.length) return false;
  for (let i = 0; i < aItems.length; i += 1) {
    if (JSON.stringify(aItems[i]) !== JSON.stringify(bItems[i])) return false;
  }
  return true;
}

function mergeSnapshot(
  env: ResponseEnvelope,
  snapshot: ResponseEnvelope,
): ResponseEnvelope {
  // Index streamed blocks by id so the snapshot's order (which is
  // authoritative) drives the output while we keep streamed refs
  // whenever content matches.
  const streamed = new Map<string, Block>();
  for (const block of env.blocks) streamed.set(block.id, block);

  const blocks: Block[] = snapshot.blocks.map((snapBlock) => {
    const live = streamed.get(snapBlock.id);
    if (!live) return snapBlock;
    // Same content: keep the live ref verbatim but adopt the
    // snapshot's final ``state`` (e.g. ``ready``) and ``reason``.
    if (blocksEquivalent(live, snapBlock)) {
      if (live.state === snapBlock.state && live.reason === snapBlock.reason) {
        return live;
      }
      return { ...live, state: snapBlock.state, reason: snapBlock.reason };
    }
    // Content differs (e.g. snapshot added late items the streaming
    // path missed) — prefer snapshot, but keep streamed ``content``
    // if the snapshot's is shorter (the stream almost certainly has
    // the complete final text for prose blocks).
    const mergedContent =
      (snapBlock.content ?? "").length >= (live.content ?? "").length
        ? snapBlock.content
        : live.content;
    return { ...snapBlock, content: mergedContent };
  });

  // Preserve streamed source/media refs when the snapshot has the same
  // source set (ordered by ``url``); otherwise adopt the snapshot's.
  const sameSources =
    env.source_surface.length === snapshot.source_surface.length &&
    env.source_surface.every((s, i) => {
      const snap = snapshot.source_surface[i] as Record<string, unknown>;
      const live = s as Record<string, unknown>;
      return String(live.url ?? "") === String(snap.url ?? "");
    });

  return {
    ...snapshot,
    blocks,
    source_surface: sameSources ? env.source_surface : snapshot.source_surface,
  };
}

// ---------------------------------------------------------------------------
// Public reducer
// ---------------------------------------------------------------------------

/**
 * Reduce a single ``PipelineEvent`` into the envelope. Unknown event
 * phases are a no-op. ``env`` may be ``undefined`` before the turn
 * begins — ``response_init`` is the only event that bootstraps from
 * scratch; every other event received with ``env === undefined``
 * returns ``undefined`` (the caller decides whether to render the
 * legacy path instead).
 */
export function reduceResponse(
  env: ResponseEnvelope | undefined,
  ev: PipelineEvent,
): ResponseEnvelope | undefined {
  switch (ev.phase) {
    case RESPONSE_INIT:
      return initEnvelope(ev.data ?? {});
    case RESPONSE_SNAPSHOT: {
      const raw = (ev.data?.envelope ?? {}) as Record<string, unknown>;
      const snapshot = envelopeFromDict(raw);
      // Live-stream case: we already built the envelope from
      // ``response_init`` + ``block_patch`` events. Replacing it
      // wholesale creates new block / item object refs identical in
      // content to what we already rendered, so React unmounts and
      // re-mounts every block — visually, the whole bubble flashes
      // when the snapshot arrives. Merge instead: keep the existing
      // block / source / media refs when content matches, only adopt
      // snapshot values that filled in genuinely new data.
      if (!env) return snapshot;
      return mergeSnapshot(env, snapshot);
    }
    default: {
      // Every remaining event needs an active envelope. If we have
      // none (e.g. fast-lane turn where ``response_init`` never
      // fires), the reducer has nothing to do.
      if (!env) return env;
      break;
    }
  }
  switch (ev.phase) {
    case BLOCK_INIT:
      return upsertBlock(env!, ev.data ?? {});
    case BLOCK_PATCH:
      return patchBlock(env!, ev.data ?? {});
    case BLOCK_READY:
      return setBlockState(env!, String(ev.data?.block_id ?? ""), "ready");
    case BLOCK_FAILED:
      return setBlockState(
        env!,
        String(ev.data?.block_id ?? ""),
        "failed",
        (ev.data?.reason as string | undefined) ?? undefined,
      );
    case SOURCE_ADD:
      return appendSource(
        env!,
        (ev.data?.source as Record<string, unknown>) ?? {},
      );
    case MEDIA_ADD:
      return appendMedia(
        env!,
        (ev.data?.media as Record<string, unknown>) ?? {},
      );
    case RESPONSE_DONE: {
      const status = (ev.data?.status as ResponseEnvelope["status"]) ?? "complete";
      return { ...env!, status };
    }
    default:
      return env;
  }
}

// Re-export the ``emptyEnvelope`` helper for tests / callers that want
// to seed an envelope manually (e.g. history replay pre-hydration).
export { emptyEnvelope };
