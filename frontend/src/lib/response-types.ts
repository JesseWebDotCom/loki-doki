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
