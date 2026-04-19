/**
 * Layer-mode chip — Map ↔ 3D segmented toggle.
 *
 * Chunk 5 of maps-local-build replaces the old single-label chip (and
 * the never-built satellite toggle) with a two-option control that
 * flips :func:`buildDarkStyle` between the flat basemap and the
 * ``fill-extrusion`` 3D-buildings overlay.
 */
import React from 'react';
import { Map as MapIcon, Box } from 'lucide-react';
import type { LayerMode } from './style-dark';

export interface LayerModeChipProps {
  mode: LayerMode;
  onChange: (mode: LayerMode) => void;
}

interface Option {
  value: LayerMode;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
}

const OPTIONS: Option[] = [
  { value: 'map', label: 'Map', Icon: MapIcon },
  { value: '3d', label: '3D', Icon: Box },
];

const LayerModeChip: React.FC<LayerModeChipProps> = ({ mode, onChange }) => (
  <div
    role="group"
    aria-label="Layer mode"
    className="inline-flex items-center gap-1 rounded-full border border-border/30 bg-card/95 p-0.5 text-xs font-medium text-muted-foreground shadow-m2 backdrop-blur"
  >
    {OPTIONS.map(({ value, label, Icon }) => {
      const active = mode === value;
      return (
        <button
          key={value}
          type="button"
          aria-pressed={active}
          aria-label={label}
          onClick={() => {
            if (!active) onChange(value);
          }}
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors',
            active
              ? 'bg-primary/15 text-foreground'
              : 'hover:text-foreground',
          ].join(' ')}
        >
          <Icon size={13} />
          <span>{label}</span>
        </button>
      );
    })}
  </div>
);

export default LayerModeChip;
