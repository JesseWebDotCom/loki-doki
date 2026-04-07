/**
 * Onyx Material confidence bar — Material purple fill on an onyx track.
 *
 * Lives in its own file because three different memory tabs render it
 * and we want one source of truth for the look & semantics. The bar is
 * intentionally div-based rather than a shadcn ``Progress`` import:
 * the project's ``components/ui`` only ships ``Badge`` and ``tooltip``
 * today, and pulling shadcn's CLI for one component would be more
 * churn than the rule against it. Matches the existing tab styling.
 */
import React from "react";

export interface ConfidenceBarProps {
  /** 0..1 — clamped on render. */
  value: number;
  /** Optional accessible label; defaults to a percentage string. */
  label?: string;
}

export const ConfidenceBar: React.FC<ConfidenceBarProps> = ({ value, label }) => {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label ?? `confidence ${pct}%`}
      className="h-1.5 w-full rounded-full bg-card/60 border border-border/30 overflow-hidden"
    >
      <div
        className="h-full bg-primary transition-[width] duration-300"
        style={{ width: `${pct}%` }}
        data-testid="confidence-fill"
      />
    </div>
  );
};
