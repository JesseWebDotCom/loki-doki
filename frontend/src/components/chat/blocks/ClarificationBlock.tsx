import React from "react";

import type { Block } from "../../../lib/response-types";
import { Button } from "../../ui/button";
import BlockShell from "./BlockShell";
import { useBlockContext } from "./index";

/**
 * Clarification block renderer (chunk 15).
 *
 * A highlighted shadcn card with the clarification question followed
 * by a set of quick-reply chips when the backend supplied candidate
 * answers. Matches design §11.3 + §22: the text is both *rendered*
 * and *spoken* — users need to hear the question to answer it, so
 * unlike ``StatusBlock`` / ``FollowUpsBlock`` this block participates
 * in voice playback. The TTS path reads ``block.content``; no
 * special-casing is required in this component beyond exposing the
 * ``data-speakable`` marker so the TTS integration can find it.
 *
 * ``block.items`` (optional) shape — one of:
 *   * ``[{ text: string }]`` — canonical envelope shape.
 *   * ``[string]`` — raw adapter list.
 *
 * When no content is present the block renders nothing.
 */
interface QuickReplyItem {
  text?: string;
}

const MAX_QUICK_REPLIES = 4;

function normalizeReply(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (entry && typeof entry === "object") {
    const text = (entry as QuickReplyItem).text;
    if (typeof text === "string") return text.trim();
  }
  return "";
}

const ClarificationBlock: React.FC<{ block: Block }> = ({ block }) => {
  const question = (block.content ?? "").trim();
  const rawItems = (block.items as unknown[] | undefined) ?? [];
  const replies = rawItems
    .map(normalizeReply)
    .filter((text) => text.length > 0)
    .slice(0, MAX_QUICK_REPLIES);

  const { onFollowUp } = useBlockContext();

  if (!question && replies.length === 0) {
    return null;
  }

  const handleReply = (reply: string) => {
    // Clarification quick-replies reuse the follow-up submit path —
    // tapping a chip sends the answer as the next user turn.
    if (onFollowUp) onFollowUp(reply);
  };

  return (
    <BlockShell
      block={block}
      skeleton={
        <div
          data-slot="clarification-skeleton"
          className="my-4 rounded-2xl border border-primary/30 bg-primary/5 p-4"
          aria-hidden="true"
        >
          <div className="h-4 w-3/4 animate-pulse rounded-md bg-muted/60" />
        </div>
      }
    >
      <div
        data-slot="clarification-block"
        data-speakable={question ? "true" : undefined}
        className="my-4 rounded-2xl border border-primary/30 bg-primary/5 p-4 shadow-m1"
        role="region"
        aria-label="Clarification"
      >
        {question ? (
          <p
            data-slot="clarification-question"
            className="text-[1rem] font-medium leading-7 text-foreground/95"
          >
            {question}
          </p>
        ) : null}

        {replies.length > 0 ? (
          <div
            data-slot="clarification-replies"
            data-reply-count={replies.length}
            className="mt-3 flex flex-wrap gap-2"
          >
            {replies.map((reply, index) => (
              <Button
                key={`${index}-${reply}`}
                type="button"
                variant="outline"
                size="sm"
                data-slot="clarification-chip"
                className="rounded-full text-[0.85rem] font-medium"
                onClick={() => handleReply(reply)}
              >
                {reply}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </BlockShell>
  );
};

export default ClarificationBlock;
