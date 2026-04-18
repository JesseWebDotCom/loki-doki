/**
 * One route-alternative card — mirror of the Apple Maps alternates list.
 *
 * States:
 *   - selected: Elevation-3 + Material Purple left border.
 *   - alternate: Elevation-1, dimmed.
 * Fastest alt gets a pill under the ETA row.
 */
import React from 'react';
import { cn } from '@/lib/utils';
import type { RouteAlt } from './DirectionsPanel.types';
import { formatDuration, formatEta, formatDistance } from './format';

export interface RouteAltCardProps {
  alt: RouteAlt;
  idx: number;
  selected: boolean;
  onSelect: (idx: number) => void;
  useMetric?: boolean;
}

const RouteAltCard: React.FC<RouteAltCardProps> = ({
  alt,
  idx,
  selected,
  onSelect,
  useMetric = false,
}) => (
  <button
    type="button"
    role="option"
    aria-selected={selected}
    data-alt-idx={idx}
    onClick={() => onSelect(idx)}
    className={cn(
      'flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors',
      selected
        ? 'border-l-4 border-primary bg-card/90 shadow-m4'
        : 'border border-border/30 bg-card/50 opacity-80 hover:opacity-100 hover:bg-card/70',
    )}
  >
    <div className="flex items-baseline justify-between gap-2">
      <div className="text-base font-semibold text-foreground">
        {formatDuration(alt.duration_s)}
      </div>
      {alt.is_fastest && (
        <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          Fastest
        </span>
      )}
    </div>
    <div className="text-xs text-muted-foreground">
      {formatEta(alt.duration_s)} · {formatDistance(alt.distance_m, useMetric)}
    </div>
  </button>
);

export default RouteAltCard;
