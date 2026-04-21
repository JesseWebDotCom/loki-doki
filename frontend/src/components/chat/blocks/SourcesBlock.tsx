import React from "react";

import type { Block } from "../../../lib/response-types";
import type { SourceInfo } from "../../../lib/api";
import BlockShell from "./BlockShell";

/**
 * Sources block renderer.
 *
 * Chunk 8 contract: behavior is intentionally invisible. The current
 * UX already shows sources two ways — inline ``SourceChip`` elements
 * inside the summary markdown (resolved from ``[src:N]`` markers), and
 * a side-drawer ``SourcesPanel`` opened by the "Sources" button in the
 * action bar. Both continue to work unchanged in ``MessageItem``.
 *
 * This renderer therefore emits a structural, visually-empty marker
 * node (``data-slot="sources-block"``) carrying the source count.
 * Chunk 11 replaces the marker with the real ``SourceSurface`` and the
 * inline trust chips once ``source_surface`` is wired through the
 * envelope.
 *
 * When ``state`` is ``omitted`` (no sources for this turn), ``BlockShell``
 * returns ``null`` and nothing is rendered — including the skeleton.
 */
const SourcesBlock: React.FC<{ block: Block }> = ({ block }) => {
  const items = (block.items as SourceInfo[] | undefined) ?? [];

  return (
    <BlockShell
      block={block}
      renderPartial
      skeleton={<div className="my-2 h-4 w-24" />}
    >
      <div
        data-slot="sources-block"
        data-source-count={items.length}
        className="hidden"
        aria-hidden="true"
      />
    </BlockShell>
  );
};

export default SourcesBlock;
