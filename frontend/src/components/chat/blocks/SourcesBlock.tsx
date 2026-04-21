import React from "react";
import { ExternalLink } from "lucide-react";

import type { Block } from "../../../lib/response-types";
import type { SourceInfo } from "../../../lib/api";
import BlockShell from "./BlockShell";
import { useBlockContext } from ".";
import SourceChip from "../SourceChip";

/**
 * Sources block renderer (chunk 11).
 *
 * Renders up to ``INLINE_LIMIT`` ``SourceChip`` items beneath the
 * summary. When the turn carries more sources than that, a "View all N
 * sources" escape is shown that delegates to the block context's
 * ``onOpenSources`` callback — the same callback the action bar uses
 * so the drawer surface is shared across entry points.
 *
 * When ``state`` is ``omitted`` (no sources for this turn) ``BlockShell``
 * returns ``null`` and nothing renders — not even the skeleton.
 */
const INLINE_LIMIT = 4;

const SourcesBlock: React.FC<{ block: Block }> = ({ block }) => {
  const items = (block.items as SourceInfo[] | undefined) ?? [];
  const { onOpenSources } = useBlockContext();

  const inline = items.slice(0, INLINE_LIMIT);
  const overflow = Math.max(items.length - inline.length, 0);

  return (
    <BlockShell
      block={block}
      renderPartial
      skeleton={<div className="my-2 h-4 w-24" />}
    >
      <div
        data-slot="sources-block"
        data-source-count={items.length}
        className="mt-3 flex flex-wrap items-center gap-1.5"
      >
        {inline.map((source, index) => (
          <SourceChip
            key={`${source.url || "source"}-${index}`}
            index={index + 1}
            source={source}
          />
        ))}
        {overflow > 0 && onOpenSources ? (
          <button
            type="button"
            data-slot="sources-view-all"
            onClick={onOpenSources}
            className="ml-1 inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border/40 bg-card/50 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:bg-card hover:text-foreground"
          >
            <span>View all {items.length} sources</span>
            <ExternalLink size={11} />
          </button>
        ) : null}
      </div>
    </BlockShell>
  );
};

export default SourcesBlock;
