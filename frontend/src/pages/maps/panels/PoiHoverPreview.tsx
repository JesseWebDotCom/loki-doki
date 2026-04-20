/**
 * Cursor-anchored POI preview with interactive actions. Apple and
 * Google Maps pop a compact card when you hover a pin that surfaces
 * the name, address, and primary affordances (Directions + share)
 * without forcing you into the full details panel. We mirror that
 * pattern so discoverable POIs can be actioned in one move.
 *
 * Pointer-events are enabled so the user can move the cursor into
 * the card; the parent (MapsPage) tracks hover-dismiss with a grace
 * timer so transitioning cursor → card doesn't collapse the card.
 */
import React from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { poiCategoryIconId } from './poi-icons';

export interface PoiHoverPreviewProps {
  name: string;
  subtitle?: string;
  category?: string;
  screenX: number;
  screenY: number;
  onDirections?: () => void;
  onShare?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const PoiHoverPreview: React.FC<PoiHoverPreviewProps> = ({
  name,
  subtitle,
  category,
  screenX,
  screenY,
  onDirections,
  onShare,
  onMouseEnter,
  onMouseLeave,
}) => {
  const iconId = poiCategoryIconId(category);
  return (
    <div
      role="dialog"
      aria-label="Place preview"
      data-testid="poi-hover-preview"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        left: screenX + 12,
        top: screenY + 12,
        zIndex: 20,
        pointerEvents: 'auto',
      }}
      className="w-[280px] rounded-xl border border-border/40 bg-card/95 p-3 shadow-m4 backdrop-blur"
    >
      <div className="flex items-start gap-2">
        {iconId ? (
          <img
            src={`/sprites/source/${iconId}.svg`}
            alt=""
            aria-hidden="true"
            className="mt-0.5 h-5 w-5 shrink-0 opacity-80"
          />
        ) : (
          <span
            aria-hidden="true"
            className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight text-foreground">
            {name}
          </div>
          {subtitle && (
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
      </div>

      {(onDirections || onShare) && (
        <div className="mt-2 flex items-center gap-1.5">
          {onDirections && (
            <button
              type="button"
              onClick={onDirections}
              className="flex flex-1 items-center justify-center gap-1 rounded-full bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <ArrowRight size={11} /> Directions
            </button>
          )}
          {onShare && (
            <button
              type="button"
              onClick={onShare}
              aria-label="Share place"
              className="flex items-center justify-center gap-1 rounded-full border border-border/40 bg-background px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              <ArrowUpRight size={11} /> Share
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default PoiHoverPreview;
