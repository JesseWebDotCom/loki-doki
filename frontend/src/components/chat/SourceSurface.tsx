import React, { useState } from "react";
import { Search } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import SourceCard, { type StructuredSource } from "./SourceCard";

interface SourceSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sources drawn from ``envelope.source_surface``. Rendered in order;
   *  no extra sort is applied here so the backend retains ordering
   *  authority. */
  sources: StructuredSource[];
  /** Optional preview of the user turn / message that cited these
   *  sources. Rendered as a subtitle in the sheet header. */
  title?: string;
}

/**
 * Dedicated source surface.
 *
 * Replaces the legacy ``SourcesPanel`` (chunk 11). Rendered as a right
 * side sheet on every viewport — on narrow devices the Radix-backed
 * sheet auto-falls back to a full-width modal, which matches the
 * "modal sheet on narrow viewports" wording in the chunk 11 spec. Our
 * shadcn ``Sheet`` primitive caps at ``sm:max-w-md`` so the drawer is
 * ~380px on wide screens and 75% viewport width on phones.
 *
 * Every ``SourceCard`` links out via a regular ``<a target=_blank>`` —
 * no runtime fetch, no preview-on-hover, no remote image loads beyond
 * what ``faviconCache.ts`` already serves with its offline-safe fallback.
 */
const SourceSurface: React.FC<SourceSurfaceProps> = ({
  open,
  onOpenChange,
  sources,
  title,
}) => {
  // Chunk 11 "Use this source next turn" affordance — local to the
  // surface for now. Real plumbing (wiring into the next turn's input
  // context) lands with the workspace / mode work.
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);

  const count = sources.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:w-[380px] lg:w-[420px] lg:max-w-[420px]"
        data-slot="source-surface"
        aria-label="Cited sources"
      >
        <SheetHeader>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Search size={15} />
            <SheetTitle className="text-xs font-bold uppercase tracking-[0.22em]">
              Cited sources · {count}
            </SheetTitle>
          </div>
          {title ? (
            <SheetDescription className="truncate text-sm font-medium text-foreground/80">
              {title}
            </SheetDescription>
          ) : null}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          {count === 0 ? (
            <p
              data-slot="source-surface-empty"
              className="px-2 py-6 text-center text-sm text-muted-foreground"
            >
              No sources for this response.
            </p>
          ) : (
            <ul className="space-y-3" data-slot="source-surface-list">
              {sources.map((source, index) => {
                const key = `${source.url || "source"}-${index}`;
                const pinned = pinnedIndex === index;
                return (
                  <li key={key} className="relative">
                    <SourceCard source={source} />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPinnedIndex(pinned ? null : index);
                      }}
                      data-slot="use-source-next"
                      data-pinned={pinned ? "true" : "false"}
                      className="absolute bottom-3 right-3 rounded-md border border-border/40 bg-background/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground data-[pinned=true]:border-primary/60 data-[pinned=true]:bg-primary/10 data-[pinned=true]:text-primary"
                      aria-pressed={pinned}
                    >
                      {pinned ? "Pinned" : "Use next"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default SourceSurface;
