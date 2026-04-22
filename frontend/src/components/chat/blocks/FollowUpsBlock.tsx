import React from "react";

import type { Block } from "../../../lib/response-types";
import { Button } from "../../ui/button";
import BlockShell from "./BlockShell";
import { useBlockContext } from "./index";

/**
 * Follow-ups block renderer (chunk 15).
 *
 * Horizontal row of shadcn ``Button variant="secondary"`` chips, each
 * a short suggested follow-up the user can tap to send as the next
 * turn. The planner only allocates this block when at least one
 * adapter produced ``follow_up_candidates`` — the component
 * additionally defends against empty / whitespace-only entries so a
 * late registry hiccup still renders gracefully.
 *
 * ``block.items`` accepts either of two shapes to be tolerant of
 * adapter drift:
 *
 *   * ``[{ text: string }]`` — the canonical shape the envelope
 *     serializer produces.
 *   * ``[string]`` — the raw adapter tuple, passed through without
 *     transformation by the backend in some paths.
 *
 * A maximum of four chips is rendered; additional entries are
 * dropped to keep the row within a kiosk-friendly tap-target budget
 * (design §15).
 *
 * Voice behavior: ``FollowUpsBlock`` is NEVER read aloud. The
 * ``spoken_text`` stream keeps its focus on the summary (design
 * §20.2). Callers wire TTS separately and should not inspect this
 * block.
 */
interface FollowUpItem {
  text?: string;
}

const MAX_CHIPS = 4;

function normalizeFollowUp(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (entry && typeof entry === "object") {
    const text = (entry as FollowUpItem).text;
    if (typeof text === "string") return text.trim();
  }
  return "";
}

const FollowUpsBlock: React.FC<{ block: Block }> = ({ block }) => {
  if (block.state !== "ready") {
    return null;
  }

  const rawItems = (block.items as unknown[] | undefined) ?? [];
  const chips = rawItems
    .map(normalizeFollowUp)
    .filter((text) => text.length > 0)
    .slice(0, MAX_CHIPS);

  const { onFollowUp } = useBlockContext();

  // No renderable chips → treat as omitted even when the backend
  // flipped the block to ``ready``. The no-fabrication rule holds
  // on the frontend too.
  if (chips.length === 0) {
    return null;
  }

  const handleClick = (chip: string) => {
    if (onFollowUp) onFollowUp(chip);
  };

  return (
    <BlockShell block={block}>
      <div
        data-slot="follow-ups-block"
        data-chip-count={chips.length}
        className="my-4 flex flex-wrap gap-2"
      >
        {chips.map((chip, index) => (
          <Button
            key={`${index}-${chip}`}
            type="button"
            variant="secondary"
            size="sm"
            data-slot="follow-ups-chip"
            className="rounded-full text-[0.85rem] font-medium"
            onClick={() => handleClick(chip)}
          >
            {chip}
          </Button>
        ))}
      </div>
    </BlockShell>
  );
};

export default FollowUpsBlock;
