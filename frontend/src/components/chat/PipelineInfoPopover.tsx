/**
 * PipelineInfoPopover — compact "i" badge that reveals the completed
 * pipeline details on hover.
 *
 * Replaces the standalone ThinkingIndicator that used to live above
 * each completed assistant message. The full per-phase breakdown
 * (decomposition / routing / synthesis latencies, routing log, model
 * + reasoning complexity) only matters when the user actively wants
 * it, so we hide it behind an icon next to the timestamp and only
 * surface it on hover.
 */
import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Brain, Route, Sparkles, Layers, Copy, Check } from "lucide-react";
import type { PipelineState } from "../../pages/ChatPage";
import { formatDuration } from "../../lib/utils";

interface Props {
  pipeline: PipelineState;
}

const PipelineInfoPopover: React.FC<Props> = ({ pipeline }) => {
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!hover || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const POPOVER_W = 320;
    const MARGIN = 8;
    // Anchor popover's right edge to the icon's right edge, clamped to viewport.
    let left = rect.right - POPOVER_W;
    if (left < MARGIN) left = MARGIN;
    if (left + POPOVER_W > window.innerWidth - MARGIN) {
      left = window.innerWidth - POPOVER_W - MARGIN;
    }
    setPos({ top: rect.bottom + 4, left });
  }, [hover]);
  // Small grace window so the user can move the mouse from the icon
  // into the popover without it slamming shut between them.
  const hideTimer = useRef<number | null>(null);
  const enter = () => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setHover(true);
  };
  const leave = () => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 180);
  };

  const decompMs = pipeline.decomposition?.latency_ms ?? 0;
  const routingMs = pipeline.routing?.latency_ms ?? 0;
  const synthMs = pipeline.synthesis?.latency_ms ?? 0;

  const handleCopy = async () => {
    const lines: string[] = [
      `Pipeline: ${pipeline.totalLatencyMs > 0 ? formatDuration(pipeline.totalLatencyMs) : "in progress"}`,
      `  Augment`,
      `  Decompose${decompMs > 0 ? "  " + formatDuration(decompMs) : ""}`,
      `  Route${
        pipeline.routing
          ? pipeline.routing.routing_log.length === 0
            ? "  LLM-only"
            : `  ${pipeline.routing.skills_resolved}✓ ${pipeline.routing.skills_failed}✗ ${formatDuration(routingMs)}`
          : ""
      }`,
      `  Synthesize${synthMs > 0 ? "  " + formatDuration(synthMs) : ""}`,
    ];
    if (pipeline.routing && pipeline.routing.routing_log.length > 0) {
      for (const e of pipeline.routing.routing_log) {
        const ms = e.latency_ms ? ` ${formatDuration(e.latency_ms)}` : "";
        lines.push(`    - [${e.status}] ${e.intent}${e.mechanism ? ` · ${e.mechanism}` : ""}${ms}`);
      }
    }
    if (pipeline.decomposition) {
      lines.push(`Model: ${pipeline.decomposition.model}`);
      lines.push(`Reasoning: ${pipeline.decomposition.reasoning_complexity}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <button
        type="button"
        aria-label="Pipeline details"
        className="inline-flex items-center justify-center w-5 h-5 rounded-md text-muted-foreground/60 hover:text-primary hover:bg-primary/10 transition"
      >
        <Info size={12} />
      </button>
      {hover && pos && createPortal(
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 320, zIndex: 9999 }}
          className="p-3 rounded-xl border border-border/60 bg-card text-foreground shadow-m4"
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <div className="flex items-center justify-between mb-2 gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Pipeline
            </span>
            <div className="flex items-center gap-2 ml-auto">
              {pipeline.totalLatencyMs > 0 && (
                <span className="text-[10px] font-mono text-primary">
                  {formatDuration(pipeline.totalLatencyMs)}
                </span>
              )}
              <button
                type="button"
                onClick={handleCopy}
                title="Copy pipeline summary"
                className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition"
              >
                {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 text-[11px]">
            <Row icon={<Layers size={11} className="text-blue-400" />} label="Augment" value="" />
            <Row
              icon={<Brain size={11} className="text-purple-400" />}
              label="Decompose"
              value={decompMs > 0 ? formatDuration(decompMs) : ""}
            />
            <Row
              icon={<Route size={11} className="text-amber-400" />}
              label="Route"
              value={
                pipeline.routing
                  ? pipeline.routing.routing_log.length === 0
                    ? "LLM-only"
                    : `${pipeline.routing.skills_resolved}✓ ${pipeline.routing.skills_failed}✗ · ${formatDuration(routingMs)}`
                  : ""
              }
            />
            <Row
              icon={<Sparkles size={11} className="text-green-400" />}
              label="Synthesize"
              value={synthMs > 0 ? formatDuration(synthMs) : ""}
            />
          </div>
          <div className="mt-2 pt-2 border-t border-border/30 flex flex-col gap-1">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">
              Skills
            </div>
            {!pipeline.routing || pipeline.routing.routing_log.length === 0 ? (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-gray-500" />
                <span className="text-muted-foreground italic">
                  No skills called — answered from model knowledge
                </span>
              </div>
            ) : (
              pipeline.routing.routing_log.map((entry) => {
                const ok = entry.status === "success";
                const noSkill = entry.status === "no_skill";
                const disabled = entry.status === "disabled";
                const dot = ok
                  ? "bg-green-500"
                  : noSkill
                    ? "bg-gray-500"
                    : disabled
                      ? "bg-amber-500"
                      : "bg-red-500";
                const skillName = entry.skill_id || (noSkill ? "no match" : "—");
                const statusLabel = ok
                  ? "ok"
                  : noSkill
                    ? "no skill"
                    : disabled
                      ? "disabled"
                      : "failed";
                return (
                  <div key={entry.ask_id} className="flex flex-col gap-0.5 text-[10px]">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                      <span className="font-mono text-foreground/90 truncate">
                        {skillName}
                      </span>
                      <span className="font-mono text-muted-foreground/70 shrink-0">
                        [{statusLabel}]
                      </span>
                      <span className="ml-auto font-mono text-muted-foreground/70 shrink-0">
                        {entry.latency_ms ? formatDuration(entry.latency_ms) : "—"}
                      </span>
                    </div>
                    <div className="pl-3.5 font-mono text-muted-foreground/70 truncate">
                      {entry.intent}
                      {entry.mechanism ? ` · ${entry.mechanism}` : ""}
                    </div>
                    {disabled && entry.disabled_reason && (
                      <div className="pl-3.5 text-amber-500/80 italic truncate">
                        {entry.disabled_reason}
                        {entry.missing_config && entry.missing_config.length > 0
                          ? ` (missing: ${entry.missing_config.join(", ")})`
                          : ""}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {pipeline.decomposition && (
            <div className="mt-2 pt-2 border-t border-border/30 text-[10px] text-muted-foreground font-mono">
              {pipeline.decomposition.model} · {pipeline.decomposition.reasoning_complexity}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

const Row: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="flex items-center gap-2">
    {icon}
    <span className="text-foreground/80">{label}</span>
    {value && <span className="ml-auto font-mono text-muted-foreground">{value}</span>}
  </div>
);

export default PipelineInfoPopover;
