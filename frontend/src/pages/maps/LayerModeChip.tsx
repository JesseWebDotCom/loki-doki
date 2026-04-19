/**
 * Layer mode chip — single ``Map`` label for this chunk.
 *
 * Chunk 5 will re-introduce this component as a Map / 3D buildings
 * toggle; chunk 4 keeps it as a non-interactive label so the UI slot
 * stays reserved.
 */
import React from 'react';
import { Map as MapIcon } from 'lucide-react';
import type { LayerMode } from './style-dark';

export interface LayerModeChipProps {
  mode: LayerMode;
  onChange: (mode: LayerMode) => void;
}

const LayerModeChip: React.FC<LayerModeChipProps> = ({ mode }) => (
  <div
    role="group"
    aria-label="Layer mode"
    className="inline-flex items-center gap-1.5 rounded-full border border-border/30 bg-card/95 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-m2 backdrop-blur"
  >
    <MapIcon size={13} />
    <span>{mode === 'map' ? 'Map' : mode}</span>
  </div>
);

export default LayerModeChip;
