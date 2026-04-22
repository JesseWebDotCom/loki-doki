/**
 * Block registry.
 *
 * A ``BlockType`` → renderer component mapping plus a small
 * ``renderBlock`` helper. Unknown block types return ``null``. Chunk
 * 14 added ``key_facts`` / ``steps`` / ``comparison``; chunk 15
 * finishes the initial registry with ``follow_ups`` /
 * ``clarification`` / ``status``.
 *
 * The registry also exposes a tiny React context so per-block renderers
 * can read the envelope-adjacent props (sources, mentioned people,
 * follow-up submit callback) that the ``{ block }``-only signature
 * doesn't carry. This keeps the renderer signature flat and matches
 * the backend ``Block`` shape exactly; sources / mentions are an
 * envelope concern, not a per-block one.
 */
import React, { createContext, useContext } from "react";

import type {
  ArtifactSurfaceData,
  Block,
  BlockType,
  EnvelopeStatus,
} from "../../../lib/response-types";
import type { SourceInfo } from "../../../lib/api";

import SummaryBlock from "./SummaryBlock";
import SourcesBlock from "./SourcesBlock";
import MediaBlock from "./MediaBlock";
import KeyFactsBlock from "./KeyFactsBlock";
import StepsBlock from "./StepsBlock";
import ComparisonBlock from "./ComparisonBlock";
import ClarificationBlock from "./ClarificationBlock";
import StatusBlock from "./StatusBlock";
import FollowUpsBlock from "./FollowUpsBlock";
import ArtifactPreviewBlock from "./ArtifactPreviewBlock";

export interface MentionedPerson {
  id: number;
  name: string;
  photo_url?: string;
  relation?: string;
}

export interface BlockContextValue {
  /** Whole-turn sources. ``SummaryBlock`` uses this to resolve
   *  ``[src:N]`` markers inline. */
  sources: SourceInfo[];
  /** Whole-turn mentioned people — enables ``/people?focus=...`` chips
   *  inside the summary markdown. */
  mentionedPeople: MentionedPerson[];
  /** Chunk 11: opens the ``SourceSurface`` drawer for the message.
   *  ``SourcesBlock`` surfaces a "View all N sources" affordance when
   *  this is provided and the list overflows the inline chip count. */
  onOpenSources?: () => void;
  /** Chunk 15: invoked when the user taps a follow-up chip or a
   *  clarification quick-reply. The host wires this to the chat
   *  submit path so the chip text arrives as the next user turn.
   *  When absent the chips render but are inert — useful for tests
   *  and history replay where re-sending would be wrong. */
  onFollowUp?: (text: string) => void;
  /** Chunk 20: current artifact surface payload for this turn. */
  artifactSurface?: ArtifactSurfaceData;
  /** Opens the dedicated artifact surface. */
  onOpenArtifact?: () => void;
  /** Current envelope lifecycle state for streaming-aware block UI. */
  envelopeStatus?: EnvelopeStatus;
}

const BlockContext = createContext<BlockContextValue>({
  sources: [],
  mentionedPeople: [],
  onOpenSources: undefined,
  onFollowUp: undefined,
  artifactSurface: undefined,
  onOpenArtifact: undefined,
  envelopeStatus: undefined,
});

interface BlockContextProviderProps extends BlockContextValue {
  children: React.ReactNode;
}

export const BlockContextProvider: React.FC<BlockContextProviderProps> = ({
  sources,
  mentionedPeople,
  onOpenSources,
  onFollowUp,
  artifactSurface,
  onOpenArtifact,
  envelopeStatus,
  children,
}) => {
  return React.createElement(
    BlockContext.Provider,
    {
      value: {
        sources,
        mentionedPeople,
        onOpenSources,
        onFollowUp,
        artifactSurface,
        onOpenArtifact,
        envelopeStatus,
      },
    },
    children,
  );
};

export function useBlockContext(): BlockContextValue {
  return useContext(BlockContext);
}

// IMPORTANT: use a getter-based registry to defeat any Vite/ESM
// module-evaluation ordering quirks around default-exported blocks
// that depend (via ``useBlockContext``) on this very module. A plain
// object literal evaluates each value eagerly at module init time;
// with the circular dep, one of the default imports could (and did —
// ``follow_ups`` in particular) resolve to ``undefined``. Wrapping the
// lookup in ``BLOCK_REGISTRY[type]`` via a function forces a live read
// and sidesteps the init-time snapshot.
function getRenderer(type: BlockType): React.FC<{ block: Block }> | undefined {
  switch (type) {
    case "summary":
      return SummaryBlock;
    case "sources":
      return SourcesBlock;
    case "media":
      return MediaBlock;
    case "key_facts":
      return KeyFactsBlock;
    case "steps":
      return StepsBlock;
    case "comparison":
      return ComparisonBlock;
    case "follow_ups":
      return FollowUpsBlock;
    case "artifact_preview":
      return ArtifactPreviewBlock;
    case "clarification":
      return ClarificationBlock;
    case "status":
      return StatusBlock;
    default:
      return undefined;
  }
}

// Exposed for tests / external callers; implemented as a Proxy so
// ``BLOCK_REGISTRY[type]`` and ``Object.keys(BLOCK_REGISTRY)`` both
// match the legacy object-literal shape while the actual component
// resolution happens at access time (see ``getRenderer`` above).
export const BLOCK_REGISTRY: Partial<
  Record<BlockType, React.FC<{ block: Block }>>
> = new Proxy({} as Partial<Record<BlockType, React.FC<{ block: Block }>>>, {
  get(_target, prop: string) {
    return getRenderer(prop as BlockType);
  },
  ownKeys() {
    return [
      "summary",
      "sources",
      "media",
      "artifact_preview",
      "key_facts",
      "steps",
      "comparison",
      "follow_ups",
      "clarification",
      "status",
    ];
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const fn = getRenderer(prop as BlockType);
    if (!fn) return undefined;
    return { configurable: true, enumerable: true, value: fn };
  },
});

/**
 * Render one block via the registry.
 *
 * Returns ``null`` for unknown block types. Silent skip is
 * intentional: the backend may ship a block type the frontend has
 * not learned yet, and the rest of the envelope must still render.
 */
export function renderBlock(block: Block): React.ReactNode {
  const Component = getRenderer(block.type);
  if (!Component) return null;
  return React.createElement(Component, { key: block.id, block });
}
