import React from "react";

import type { Block } from "../../../lib/response-types";
import { Skeleton } from "../../ui/skeleton";
import { useBlockContext } from "./index";

interface BlockShellProps {
  block: Block;
  /** Rendered when ``block.state`` is ``ready`` (or ``partial`` when
   *  ``renderPartial`` is true). */
  children: React.ReactNode;
  /**
   * When true, the child is rendered during ``partial`` too. Use this
   * for streaming text blocks (summary) where the in-progress prose
   * is the right thing to show. Defaults to false — most blocks stay
   * skeleton until they are ``ready``.
   */
  renderPartial?: boolean;
  /** Optional override for the loading skeleton (keeps MediaBlock /
   *  SourcesBlock able to hint their eventual shape). */
  skeleton?: React.ReactNode;
  className?: string;
}

/**
 * Common state chrome for every block.
 *
 * - ``loading`` / ``partial`` → skeleton (unless ``renderPartial`` opts
 *   the child in for ``partial``).
 * - ``ready`` → child.
 * - ``omitted`` → render nothing (null). The planner intentionally
 *   dropped this block; downstream layout should not reserve space.
 * - ``failed`` → muted one-line chip with ``block.reason``.
 *
 * No raw styled ``<div>`` beyond layout — the visual container is the
 * caller's responsibility (today each block type is borderless prose;
 * chunk 14/15 will wrap richer cards in ``<Card />``).
 */
const BlockShell: React.FC<BlockShellProps> = ({
  block,
  children,
  renderPartial = false,
  skeleton,
  className,
}) => {
  const { envelopeStatus } = useBlockContext();
  const isStreaming = envelopeStatus === "streaming";

  if (block.state === "omitted") {
    return null;
  }

  if (block.state === "failed") {
    return (
      <div
        data-slot="block-failed"
        data-block-id={block.id}
        className="my-2 inline-flex items-center gap-2 rounded-lg border border-border/40 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground md:my-3"
      >
        <span className="font-mono uppercase tracking-widest text-[9px] text-muted-foreground/70">
          {block.type}
        </span>
        <span>{block.reason ?? "unavailable"}</span>
      </div>
    );
  }

  if (block.state === "loading" || (block.state === "partial" && !renderPartial)) {
    // During a live stream the ThinkingIndicator below already tells
    // the user progress is happening, and every skeleton we render here
    // stacks ~88px of empty height. Multiplied across pending blocks
    // (summary + key_facts + steps + sources + follow_ups...) that
    // produces the large gap between the streaming text and the
    // status indicator. Collapse to null until the block actually has
    // something to show — the block pops in as its content arrives.
    if (isStreaming) {
      return null;
    }
    return (
      <div
        data-slot="block-loading"
        data-block-id={block.id}
        className={className}
      >
        {skeleton ?? (
          <div className="my-3 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </div>
    );
  }

  // ready | partial (when renderPartial=true)
  return (
    <div
      data-slot="block-ready"
      data-block-id={block.id}
      data-block-state={block.state}
      className={className}
    >
      {children}
    </div>
  );
};

export default BlockShell;
