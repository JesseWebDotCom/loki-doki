/**
 * Three-segment Map / Satellite / Hybrid toggle chip.
 *
 * Sits in the top-right of the map surface, stacked below MapLibre's
 * navigation controls. Matches the Apple-Maps layered chip look —
 * Onyx Elevation 2 with purple accent on the active segment.
 *
 * Keyboard accessible via native button focus + Arrow-Left / Arrow-Right
 * navigation across the three segments.
 */
import React, { useRef } from 'react';
import { Map as MapIcon, Satellite, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LayerMode } from './style-dark';

export interface LayerModeChipProps {
  mode: LayerMode;
  onChange: (mode: LayerMode) => void;
  satelliteAvailable: boolean;
}

interface Segment {
  value: LayerMode;
  label: string;
  Icon: typeof MapIcon;
  needsSatellite: boolean;
}

const SEGMENTS: Segment[] = [
  { value: 'map',       label: 'Map',       Icon: MapIcon,   needsSatellite: false },
  { value: 'satellite', label: 'Satellite', Icon: Satellite, needsSatellite: true  },
  { value: 'hybrid',    label: 'Hybrid',    Icon: Layers,    needsSatellite: true  },
];

const LayerModeChip: React.FC<LayerModeChipProps> = ({
  mode,
  onChange,
  satelliteAvailable,
}) => {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusSegment = (idx: number) => {
    const target = refs.current[(idx + SEGMENTS.length) % SEGMENTS.length];
    target?.focus();
  };

  const handleKey = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusSegment(idx + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusSegment(idx - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Layer mode"
      className="inline-flex items-center gap-0.5 rounded-full border border-border/30 bg-card/95 p-1 shadow-m2 backdrop-blur"
    >
      {SEGMENTS.map((seg, idx) => {
        const disabled = seg.needsSatellite && !satelliteAvailable;
        const active = mode === seg.value;
        return (
          <button
            key={seg.value}
            ref={(el) => { refs.current[idx] = el; }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={seg.label}
            disabled={disabled}
            title={
              disabled
                ? 'Install a region with satellite imagery to enable'
                : seg.label
            }
            onClick={() => !disabled && onChange(seg.value)}
            onKeyDown={(e) => handleKey(e, idx)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer',
              active
                ? 'bg-primary/20 text-primary-foreground shadow-inner'
                : 'text-muted-foreground hover:text-foreground hover:bg-card',
              disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
            )}
          >
            <seg.Icon size={13} />
            <span>{seg.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default LayerModeChip;
