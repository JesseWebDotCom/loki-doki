/**
 * Scrollable turn-by-turn list for the selected route. Each row is
 * clickable — the parent (DirectionsPanel) wires that to a map fit-to
 * on the maneuver's shape range.
 *
 * Valhalla emits a numeric `type` per maneuver; the glyph map below
 * is a small, deterministic translation. Anything not in the map falls
 * back to ArrowRight — routing still works, the glyph just isn't as
 * specific.
 */
import React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerDownLeft,
  CornerDownRight,
  Flag,
  MapPin,
  Merge,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Maneuver } from './DirectionsPanel.types';
import { formatDistance } from './format';

export interface TurnByTurnListProps {
  maneuvers: Maneuver[];
  activeIdx: number | null;
  onSelect: (idx: number) => void;
  useMetric?: boolean;
}

// Valhalla maneuver-type codes — condensed to the ones we care about.
// Source: valhalla/valhalla docs directions-options maneuver types.
const GLYPH_BY_TYPE: Record<number, React.ComponentType<{ size?: number }>> = {
  1: MapPin, // start
  2: MapPin, // start right
  3: MapPin, // start left
  4: Flag, // destination
  5: Flag, // destination right
  6: Flag, // destination left
  10: ArrowUp, // continue
  11: ArrowUp, // become (implicit continue)
  15: ArrowUpRight, // slight right
  16: ArrowRight, // right
  17: CornerDownRight, // sharp right
  20: CornerDownLeft, // sharp left
  21: ArrowLeft, // left
  22: ArrowUpLeft, // slight left
  25: Merge, // merge
  26: Merge, // merge right
  27: Merge, // merge left
  36: RotateCcw, // u-turn
};

const TurnByTurnList: React.FC<TurnByTurnListProps> = ({
  maneuvers,
  activeIdx,
  onSelect,
  useMetric = false,
}) => {
  if (maneuvers.length === 0) return null;
  return (
    <ol
      aria-label="Turn-by-turn directions"
      className="flex max-h-64 flex-col divide-y divide-border/20 overflow-y-auto rounded-xl border border-border/30 bg-card/40"
    >
      {maneuvers.map((m, idx) => {
        const Glyph = GLYPH_BY_TYPE[m.type] ?? ArrowRight;
        const active = activeIdx === idx;
        return (
          <li key={idx}>
            <button
              type="button"
              aria-current={active ? 'step' : undefined}
              onClick={() => onSelect(idx)}
              className={cn(
                'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors',
                active ? 'bg-primary/10 text-foreground' : 'hover:bg-card/70',
              )}
            >
              <Glyph size={16} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">{m.instruction}</div>
                {m.distance_m > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {formatDistance(m.distance_m, useMetric)}
                  </div>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
};

export default TurnByTurnList;
