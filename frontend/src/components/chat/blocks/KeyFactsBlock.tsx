import React from "react";

import type { Block } from "../../../lib/response-types";
import { Skeleton } from "../../ui/skeleton";
import BlockShell from "./BlockShell";

/**
 * Key-facts block renderer (chunk 14).
 *
 * Vertical bullet list of up to eight short strings sourced
 * deterministically from adapter ``facts``. Skeleton hints four bullet
 * placeholders while the block is ``loading``. An ``omitted`` block
 * renders nothing (handled by ``BlockShell``).
 *
 * ``block.items`` shape: ``[{ text: string }]``. Extra fields are
 * ignored — the shape lives in ``synthesis_blocks.aggregate_key_facts``
 * on the backend.
 */
interface KeyFactItem {
  text?: string;
}

const MAX_FACTS = 8;

const KeyFactsBlock: React.FC<{ block: Block }> = ({ block }) => {
  const rawItems = (block.items as KeyFactItem[] | undefined) ?? [];
  const items = rawItems
    .map((entry) => String(entry?.text ?? "").trim())
    .filter((text) => text.length > 0)
    .slice(0, MAX_FACTS);

  return (
    <BlockShell
      block={block}
      skeleton={
        <div
          data-slot="key-facts-skeleton"
          className="my-4 space-y-2"
          aria-hidden="true"
        >
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-start gap-2">
              <Skeleton className="mt-2 h-1.5 w-1.5 rounded-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      }
    >
      <div
        data-slot="key-facts-block"
        data-fact-count={items.length}
        className="my-4"
      >
        <ul className="ml-5 list-disc space-y-1.5 text-[0.95rem] leading-7 text-foreground/90">
          {items.map((text, index) => (
            <li key={index} className="pl-1">
              {text}
            </li>
          ))}
        </ul>
      </div>
    </BlockShell>
  );
};

export default KeyFactsBlock;
