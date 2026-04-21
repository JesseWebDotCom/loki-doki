import React from "react";

import type { Block } from "../../../lib/response-types";

/**
 * Status block renderer (chunk 15).
 *
 * Single-line muted text with a subtle Tailwind ``animate-pulse`` so
 * the user sees the phrase "breathe" while the pipeline is still
 * working. Phrases come from
 * :mod:`lokidoki.orchestrator.response.status_strings` and are
 * patched onto ``block.content`` at phase transitions.
 *
 * Lifecycle:
 *   * ``loading`` before any patch — renders a muted placeholder
 *     pulse so the row is visible but silent.
 *   * ``partial`` / ``ready`` — renders the current phrase with an
 *     animated pulse to signal "live".
 *   * ``omitted`` / ``failed`` — renders nothing. The design doc is
 *     explicit that the status block is a live-only surface and
 *     should disappear on turn completion (``response_done`` flips
 *     it to ``omitted``) or block failure (the pipeline patches the
 *     phrase to "finishing up" but the frontend keeps the muted
 *     display because error surfacing lives on the failing block
 *     itself).
 *
 * Voice behavior: the status block MAY be spoken at most once per
 * phase and only when the turn has been running >3s (design §22).
 * Voice scheduling lives in the TTS pipeline wired by chunk 16; this
 * component simply exposes ``data-speakable-phrase`` so that path
 * can pick it up without re-deriving the phrase. The component
 * itself does not call TTS.
 */
const StatusBlock: React.FC<{ block: Block }> = ({ block }) => {
  // ``omitted`` and ``failed`` states hide the block entirely — see
  // the component doc. We don't use ``BlockShell`` because the
  // shell's skeleton chrome is too heavy for a single muted status
  // line.
  if (block.state === "omitted" || block.state === "failed") {
    return null;
  }

  const phrase = (block.content ?? "").trim();

  // Before the first patch the block is ``loading`` with no content.
  // Render an empty, animated placeholder so the row's height is
  // reserved and the first phrase doesn't make the layout jump.
  if (!phrase) {
    return (
      <div
        data-slot="status-block"
        data-state={block.state}
        className="my-3 h-5 flex items-center"
        aria-hidden="true"
      >
        <span className="h-1.5 w-20 animate-pulse rounded-full bg-muted/60" />
      </div>
    );
  }

  return (
    <div
      data-slot="status-block"
      data-state={block.state}
      data-block-id={block.id}
      data-speakable-phrase={phrase}
      className="my-3 flex items-center gap-2 text-[0.85rem] text-muted-foreground/80"
      role="status"
      aria-live="polite"
    >
      <span
        data-slot="status-pulse"
        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary/60"
        aria-hidden="true"
      />
      <span data-slot="status-phrase" className="animate-pulse">
        {phrase}
      </span>
    </div>
  );
};

export default StatusBlock;
