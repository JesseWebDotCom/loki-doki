import React from "react";
import { Layers, Search, SlidersHorizontal, Sparkles } from "lucide-react";

import type { ResponseEnvelope } from "../../lib/response-types";

/**
 * DeepWorkFrame — chunk 18.
 *
 * Progress-oriented shell for deep-work turns. Not a bespoke block
 * renderer: the inner block stack is still rendered by the shared
 * block registry via ``MessageItem``. This component only wraps the
 * block stack with a stage strip + accent styling so the user sees
 * that a deep turn is running and which stage it's currently on.
 *
 * Design §10.4 / §21.1 — deep-work frame is one of four answer
 * frames (chat / search / deep-work / artifact). The frame collapses
 * to nothing once ``envelope.status === "complete"`` so history replay
 * and the finalized envelope render identically to a normal rich
 * turn.
 */

const STAGES: Array<{
  id: "expand" | "gather" | "summary" | "finalize";
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { id: "expand", label: "Expanding", icon: SlidersHorizontal },
  { id: "gather", label: "Gathering", icon: Search },
  { id: "summary", label: "Summarizing", icon: Sparkles },
  { id: "finalize", label: "Finalizing", icon: Layers },
];

type StageState = "pending" | "active" | "done";

export interface DeepWorkFrameProps {
  envelope: ResponseEnvelope;
  children: React.ReactNode;
}

/**
 * Derive a rough per-stage state purely from the envelope. We do not
 * mirror the backend ``DeepStageEvent`` stream to avoid a dedicated
 * client-side state channel; the block shapes are enough to know how
 * far the run has progressed:
 *
 *   * sources populated → ``gather`` done.
 *   * summary populated → ``summary`` done.
 *   * key_facts / comparison / steps ready → ``finalize`` done.
 *
 * When ``status === "complete"`` every stage is marked done so the
 * strip collapses into a compact trail rather than hanging on
 * "finalizing".
 */
function deriveStageStates(envelope: ResponseEnvelope): Record<string, StageState> {
  const complete = envelope.status === "complete";

  const hasSources =
    (envelope.source_surface?.length ?? 0) > 0 ||
    envelope.blocks.some(
      (b) => b.type === "sources" && (b.items?.length ?? 0) > 0,
    );

  const summaryBlock = envelope.blocks.find((b) => b.type === "summary");
  const hasSummary =
    summaryBlock != null &&
    (summaryBlock.state === "partial" ||
      summaryBlock.state === "ready") &&
    Boolean((summaryBlock.content ?? "").trim());

  const hasFinalized = envelope.blocks.some(
    (b) =>
      (b.type === "key_facts" ||
        b.type === "comparison" ||
        b.type === "steps") &&
      b.state === "ready",
  );

  const states: Record<string, StageState> = {
    expand: "pending",
    gather: "pending",
    summary: "pending",
    finalize: "pending",
  };

  // "expand" is effectively implicit — once we see *any* evidence or
  // finished synthesis work, it's done. When complete, always done.
  states.expand = complete || hasSources || hasSummary ? "done" : "active";

  if (hasSources) {
    states.gather = "done";
  } else if (states.expand === "done") {
    states.gather = complete ? "done" : "active";
  }

  if (hasSummary) {
    states.summary = "done";
  } else if (states.gather === "done") {
    states.summary = complete ? "done" : "active";
  }

  if (hasFinalized) {
    states.finalize = "done";
  } else if (states.summary === "done") {
    states.finalize = complete ? "done" : "active";
  }

  if (complete) {
    for (const key of Object.keys(states)) {
      states[key] = "done";
    }
  }

  return states;
}

const DeepWorkFrame: React.FC<DeepWorkFrameProps> = ({ envelope, children }) => {
  const stageStates = deriveStageStates(envelope);
  const isStreaming = envelope.status === "streaming";

  return (
    <section
      data-slot="deep-work-frame"
      data-streaming={isStreaming ? "true" : "false"}
      aria-label="Deep work response"
      className="relative rounded-2xl border border-primary/15 bg-primary/[0.035] p-4 shadow-inner"
    >
      <header
        data-slot="deep-stage-strip"
        className="mb-4 flex items-center justify-between gap-3 border-b border-primary/10 pb-3"
      >
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary/70">
          <Sparkles size={12} aria-hidden />
          Deep work
        </div>
        <ol
          role="list"
          data-slot="deep-stage-list"
          className="flex items-center gap-2 text-[11px] text-muted-foreground"
        >
          {STAGES.map((stage) => {
            const state = stageStates[stage.id] ?? "pending";
            const Icon = stage.icon;
            return (
              <li
                key={stage.id}
                data-slot="deep-stage"
                data-stage-id={stage.id}
                data-stage-state={state}
                aria-current={state === "active" ? "step" : undefined}
                className={
                  state === "active"
                    ? "flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-primary"
                    : state === "done"
                      ? "flex items-center gap-1.5 rounded-full bg-primary/5 px-2 py-0.5 text-primary/70"
                      : "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-muted-foreground/50"
                }
              >
                <Icon
                  size={11}
                  className={state === "active" ? "animate-pulse" : undefined}
                  aria-hidden
                />
                <span>{stage.label}</span>
              </li>
            );
          })}
        </ol>
      </header>
      <div data-slot="deep-stage-content">{children}</div>
    </section>
  );
};

export default DeepWorkFrame;
