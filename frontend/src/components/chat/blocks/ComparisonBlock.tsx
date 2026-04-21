import React from "react";

import type { Block } from "../../../lib/response-types";
import { Skeleton } from "../../ui/skeleton";
import BlockShell from "./BlockShell";

/**
 * Comparison block renderer (chunk 14).
 *
 * Two-column layout on ≥720px viewports, stacked on narrower screens.
 * ``block.comparison`` carries ``{ left, right, dimensions }`` where
 * ``left`` / ``right`` are ``{ title, items }`` (items is a list of
 * short strings, one per dimension). Each dimension row compares the
 * matching left/right item side-by-side when ``items`` are aligned to
 * ``dimensions``; otherwise the items lists render as bullet lists.
 *
 * An empty comparison payload (no items on either side, no dimensions)
 * renders only the two titles — the summary block carries the
 * comparative prose narrative. An ``omitted`` block renders nothing
 * (handled by ``BlockShell``).
 */
interface ComparisonSide {
  title?: string;
  items?: string[];
}
interface ComparisonPayload {
  left?: ComparisonSide;
  right?: ComparisonSide;
  dimensions?: string[];
}

function normalizeSide(side: ComparisonSide | undefined): {
  title: string;
  items: string[];
} {
  return {
    title: String(side?.title ?? "").trim(),
    items: Array.isArray(side?.items)
      ? side!.items!.map((item) => String(item ?? "").trim()).filter((s) => s.length > 0)
      : [],
  };
}

const ComparisonBlock: React.FC<{ block: Block }> = ({ block }) => {
  const payload = (block.comparison ?? {}) as ComparisonPayload;
  const left = normalizeSide(payload.left);
  const right = normalizeSide(payload.right);
  const dimensions = Array.isArray(payload.dimensions)
    ? payload.dimensions
        .map((dim) => String(dim ?? "").trim())
        .filter((s) => s.length > 0)
    : [];

  const hasAlignedDimensions =
    dimensions.length > 0 &&
    left.items.length === dimensions.length &&
    right.items.length === dimensions.length;

  return (
    <BlockShell
      block={block}
      skeleton={
        <div
          data-slot="comparison-skeleton"
          className="my-4 grid grid-cols-1 gap-3 md:grid-cols-2"
          aria-hidden="true"
        >
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      }
    >
      <div
        data-slot="comparison-block"
        data-dimension-count={dimensions.length}
        className="my-4 overflow-hidden rounded-xl border border-border/40 bg-card/40"
      >
        <div
          className="grid grid-cols-1 divide-border/40 md:grid-cols-2 md:divide-x"
          data-slot="comparison-headers"
        >
          <div className="px-4 py-2 text-sm font-semibold text-foreground">
            {left.title || "Option A"}
          </div>
          <div className="px-4 py-2 text-sm font-semibold text-foreground">
            {right.title || "Option B"}
          </div>
        </div>
        {hasAlignedDimensions ? (
          <div data-slot="comparison-rows" className="divide-y divide-border/30">
            {dimensions.map((dim, index) => (
              <div
                key={dim}
                data-slot="comparison-row"
                className="grid grid-cols-1 divide-border/40 md:grid-cols-2 md:divide-x"
              >
                <div className="px-4 py-2 text-sm leading-6">
                  <span className="mr-1 text-[11px] font-mono uppercase tracking-wide text-muted-foreground/80">
                    {dim}
                  </span>
                  <span className="text-foreground/85">{left.items[index]}</span>
                </div>
                <div className="px-4 py-2 text-sm leading-6">
                  <span className="mr-1 text-[11px] font-mono uppercase tracking-wide text-muted-foreground/80">
                    {dim}
                  </span>
                  <span className="text-foreground/85">{right.items[index]}</span>
                </div>
              </div>
            ))}
          </div>
        ) : left.items.length > 0 || right.items.length > 0 ? (
          <div
            data-slot="comparison-items"
            className="grid grid-cols-1 divide-border/40 md:grid-cols-2 md:divide-x"
          >
            <ul className="list-disc space-y-1 px-8 py-3 text-sm leading-6 text-foreground/85">
              {left.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
            <ul className="list-disc space-y-1 px-8 py-3 text-sm leading-6 text-foreground/85">
              {right.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </BlockShell>
  );
};

export default ComparisonBlock;
