/**
 * TypeScript mirror of the backend ``ResponseEnvelope`` / ``Block`` /
 * ``BlockType`` / ``BlockState`` shapes.
 *
 * The names match the Python dataclasses in
 * ``lokidoki/orchestrator/response/{blocks,envelope}.py`` on purpose so
 * the SSE payload can be deserialized straight into these types without
 * a translation layer. When you edit one side, edit both.
 *
 * Block payloads are intentionally loose (``items?: unknown[]``,
 * ``content?: string``) — the per-type renderers in
 * ``components/chat/blocks/`` narrow these at the render site rather
 * than forcing a discriminated union here. That matches the ``api-types``
 * precedent (see ``PipelineEvent.data: any`` comment).
 */
import type { SourceInfo, MediaCard } from "./api-types";

export type BlockState =
  | "loading"
  | "partial"
  | "ready"
  | "omitted"
  | "failed";

export type BlockType =
  | "summary"
  | "key_facts"
  | "steps"
  | "comparison"
  | "sources"
  | "media"
  | "cta_links"
  | "clarification"
  | "follow_ups"
  | "status";

export interface ComparisonPayload {
  left: unknown;
  right: unknown;
  dimensions: string[];
}

export interface Block {
  id: string;
  type: BlockType;
  state: BlockState;
  seq: number;
  reason?: string;
  content?: string;
  items?: unknown[];
  comparison?: ComparisonPayload;
}

export interface Hero {
  title: string;
  subtitle?: string;
  image_url?: string;
}

export type EnvelopeMode =
  | "direct"
  | "standard"
  | "rich"
  | "deep"
  | "search"
  | "artifact";

export type EnvelopeStatus = "streaming" | "complete" | "failed";

export interface ResponseEnvelope {
  request_id: string;
  mode: EnvelopeMode;
  status: EnvelopeStatus;
  hero?: Hero;
  blocks: Block[];
  source_surface: unknown[];
  artifact_surface?: Record<string, unknown>;
  spoken_text?: string;
}

/**
 * Narrower payload types the per-type renderers in
 * ``components/chat/blocks/`` cast to. Re-exported from here so the
 * block files import a single module for both the envelope shapes and
 * the item shapes they ultimately render.
 */
export type SourcesBlockItem = SourceInfo;
export type MediaBlockItem = MediaCard;

// ---------------------------------------------------------------------------
// Deserialization helpers (mirror of backend ``response/serde.py``)
// ---------------------------------------------------------------------------
//
// Used by two call sites in chunk 10:
//
//   * the reducer in ``response-reducer.ts`` when applying
//     ``response_snapshot`` events (the backend emits the envelope via
//     ``envelope_to_dict`` — we invert it here).
//   * history replay when a persisted ``messages.response_envelope``
//     column is loaded and the frontend needs to render from the
//     stored snapshot without re-running synthesis.
//
// Unknown discriminators (``mode``, ``status``, block ``type`` /
// ``state``) fall back to tolerant defaults rather than throwing — the
// reducer is a runtime data path and a malformed snapshot should
// degrade gracefully, not crash the chat view. Tests assert the
// happy-path round trip.

const VALID_MODES: readonly EnvelopeMode[] = [
  "direct",
  "standard",
  "rich",
  "deep",
  "search",
  "artifact",
];
const VALID_STATUSES: readonly EnvelopeStatus[] = [
  "streaming",
  "complete",
  "failed",
];
const VALID_BLOCK_TYPES: readonly BlockType[] = [
  "summary",
  "key_facts",
  "steps",
  "comparison",
  "sources",
  "media",
  "cta_links",
  "clarification",
  "follow_ups",
  "status",
];
const VALID_BLOCK_STATES: readonly BlockState[] = [
  "loading",
  "partial",
  "ready",
  "omitted",
  "failed",
];

export function blockFromDict(data: Record<string, unknown>): Block {
  const rawType = data.type as string;
  const rawState = (data.state as string) ?? "loading";
  return {
    id: String(data.id),
    type: (VALID_BLOCK_TYPES as readonly string[]).includes(rawType)
      ? (rawType as BlockType)
      : ("summary" as BlockType),
    state: (VALID_BLOCK_STATES as readonly string[]).includes(rawState)
      ? (rawState as BlockState)
      : ("loading" as BlockState),
    seq: typeof data.seq === "number" ? data.seq : 0,
    reason: (data.reason as string | undefined) ?? undefined,
    content: (data.content as string | undefined) ?? undefined,
    items: Array.isArray(data.items) ? (data.items as unknown[]) : undefined,
    comparison: data.comparison
      ? (data.comparison as ComparisonPayload)
      : undefined,
  };
}

export function envelopeFromDict(
  data: Record<string, unknown>,
): ResponseEnvelope {
  const rawMode = (data.mode as string) ?? "standard";
  const rawStatus = (data.status as string) ?? "streaming";
  const mode: EnvelopeMode = (VALID_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as EnvelopeMode)
    : "standard";
  const status: EnvelopeStatus = (
    VALID_STATUSES as readonly string[]
  ).includes(rawStatus)
    ? (rawStatus as EnvelopeStatus)
    : "streaming";
  const heroRaw = data.hero as Record<string, unknown> | undefined;
  const hero: Hero | undefined = heroRaw
    ? {
        title: String(heroRaw.title ?? ""),
        subtitle: heroRaw.subtitle as string | undefined,
        image_url: heroRaw.image_url as string | undefined,
      }
    : undefined;
  const blocks = Array.isArray(data.blocks)
    ? (data.blocks as Record<string, unknown>[]).map(blockFromDict)
    : [];
  const sourceSurface = Array.isArray(data.source_surface)
    ? (data.source_surface as unknown[])
    : [];
  return {
    request_id: String(data.request_id ?? ""),
    mode,
    status,
    hero,
    blocks,
    source_surface: sourceSurface,
    artifact_surface: (data.artifact_surface as Record<string, unknown>) ?? undefined,
    spoken_text: (data.spoken_text as string | undefined) ?? undefined,
  };
}
