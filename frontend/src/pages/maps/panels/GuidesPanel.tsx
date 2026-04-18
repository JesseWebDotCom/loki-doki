/**
 * Guides panel — disabled placeholder for Chunk 4. Real curated guides
 * arrive in a later roadmap item (see PLAN.md non-goals).
 */
import React from 'react';
import {
  Coffee,
  Utensils,
  Landmark,
  ShoppingBag,
  BedDouble,
  TreePine,
  X,
} from 'lucide-react';

export interface GuidesPanelProps {
  onClose: () => void;
}

const CATEGORIES = [
  { label: 'Food', Icon: Utensils },
  { label: 'Coffee', Icon: Coffee },
  { label: 'Museums', Icon: Landmark },
  { label: 'Shopping', Icon: ShoppingBag },
  { label: 'Hotels', Icon: BedDouble },
  { label: 'Outdoors', Icon: TreePine },
];

const GuidesPanel: React.FC<GuidesPanelProps> = ({ onClose }) => (
  <section
    role="tabpanel"
    aria-label="Guides"
    className="flex h-full w-full flex-col gap-4 p-4"
  >
    <header className="flex items-center justify-between">
      <h2 className="text-lg font-semibold tracking-tight">Guides</h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close guides"
        className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-card"
      >
        <X size={16} />
      </button>
    </header>

    <div className="rounded-xl border border-border/30 bg-card/40 p-4 text-sm text-muted-foreground">
      Curated places coming soon — install a region and browse by category.
    </div>

    <div
      aria-hidden
      className="grid grid-cols-2 gap-2 opacity-40 pointer-events-none"
    >
      {CATEGORIES.map(({ label, Icon }) => (
        <div
          key={label}
          className="flex flex-col items-start gap-2 rounded-xl border border-border/30 bg-card/60 p-3"
        >
          <Icon size={18} className="text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-[11px] text-muted-foreground">Coming soon</div>
        </div>
      ))}
    </div>
  </section>
);

export default GuidesPanel;
