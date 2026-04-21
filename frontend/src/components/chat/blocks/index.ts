/**
 * Block registry.
 *
 * A ``BlockType`` → renderer component mapping plus a small
 * ``renderBlock`` helper. Unknown block types return ``null`` — chunks
 * 14 / 15 fill in the rest (key_facts, steps, comparison, cta_links,
 * clarification, follow_ups, status).
 *
 * The registry also exposes a tiny React context so per-block renderers
 * can read the envelope-adjacent props (sources, mentioned people) that
 * the ``{ block }``-only signature doesn't carry. This keeps the
 * renderer signature flat and matches the backend ``Block`` shape
 * exactly; sources / mentions are an envelope concern, not a per-block
 * one (chunk 11 will route these through ``source_surface``).
 */
import React, { createContext, useContext } from "react";

import type { Block, BlockType } from "../../../lib/response-types";
import type { SourceInfo } from "../../../lib/api";

import SummaryBlock from "./SummaryBlock";
import SourcesBlock from "./SourcesBlock";
import MediaBlock from "./MediaBlock";

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
}

const BlockContext = createContext<BlockContextValue>({
  sources: [],
  mentionedPeople: [],
});

interface BlockContextProviderProps extends BlockContextValue {
  children: React.ReactNode;
}

export const BlockContextProvider: React.FC<BlockContextProviderProps> = ({
  sources,
  mentionedPeople,
  children,
}) => {
  return React.createElement(
    BlockContext.Provider,
    { value: { sources, mentionedPeople } },
    children,
  );
};

export function useBlockContext(): BlockContextValue {
  return useContext(BlockContext);
}

export const BLOCK_REGISTRY: Partial<
  Record<BlockType, React.FC<{ block: Block }>>
> = {
  summary: SummaryBlock,
  sources: SourcesBlock,
  media: MediaBlock,
};

/**
 * Render one block via the registry.
 *
 * Returns ``null`` for unknown block types — chunks 14 / 15 fill in the
 * rest. Silent skip is intentional: the backend may ship a block type
 * the frontend has not learned yet, and the rest of the envelope must
 * still render.
 */
export function renderBlock(block: Block): React.ReactNode {
  const Component = BLOCK_REGISTRY[block.type];
  if (!Component) return null;
  return React.createElement(Component, { key: block.id, block });
}
