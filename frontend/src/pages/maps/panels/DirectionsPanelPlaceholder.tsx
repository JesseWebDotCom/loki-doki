/**
 * Disabled skeleton of the Directions panel (Chunk 7 ships the real
 * routing UI). Kept visible so the left rail's Directions item is
 * never a dead end — clicking it lands here, clicking the blue
 * Directions button from a place card lands here with `toPlace`
 * pre-populated.
 */
import React from 'react';
import { ArrowDownUp, Car, Footprints, Bike, X } from 'lucide-react';
import type { PlaceResult } from '../types';

export interface DirectionsPanelPlaceholderProps {
  toPlace: PlaceResult | null;
  onClose: () => void;
}

const MODES = [
  { label: 'Drive', Icon: Car },
  { label: 'Walk', Icon: Footprints },
  { label: 'Cycle', Icon: Bike },
];

const DirectionsPanelPlaceholder: React.FC<DirectionsPanelPlaceholderProps> = ({
  toPlace,
  onClose,
}) => (
  <section
    role="tabpanel"
    aria-label="Directions"
    aria-disabled="true"
    className="flex h-full w-full flex-col gap-4 p-4"
  >
    <header className="flex items-center justify-between">
      <h2 className="text-lg font-semibold tracking-tight">Directions</h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close directions"
        className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-card"
      >
        <X size={16} />
      </button>
    </header>

    <div
      className="flex flex-col gap-2 rounded-xl border border-border/30 bg-card/40 p-3 opacity-70"
      title="Ships in Chunk 7"
    >
      <div className="flex items-center gap-2">
        <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/50" />
        <input
          aria-label="From"
          placeholder="My Location"
          disabled
          className="flex-1 bg-transparent text-sm text-muted-foreground placeholder:text-muted-foreground outline-none"
        />
      </div>
      <div className="flex items-center justify-center">
        <ArrowDownUp size={14} className="text-muted-foreground" />
      </div>
      <div className="flex items-center gap-2">
        <div className="h-2.5 w-2.5 rounded-sm bg-primary/60" />
        <input
          aria-label="To"
          placeholder="Choose destination"
          value={toPlace?.title ?? ''}
          disabled
          readOnly
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
        />
      </div>
    </div>

    <div
      aria-hidden
      className="grid grid-cols-3 gap-2 opacity-60 pointer-events-none"
    >
      {MODES.map(({ label, Icon }) => (
        <div
          key={label}
          className="flex items-center justify-center gap-2 rounded-full border border-border/30 bg-card/60 px-3 py-2 text-xs text-muted-foreground"
        >
          <Icon size={14} />
          <span>{label}</span>
        </div>
      ))}
    </div>

    <div className="rounded-xl border border-dashed border-border/30 bg-card/20 p-3 text-xs text-muted-foreground">
      Coming soon — ships with routing in Chunk 7.
    </div>
  </section>
);

export default DirectionsPanelPlaceholder;
