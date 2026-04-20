/**
 * Compact preview card shown when the cursor hovers a POI pin. Apple
 * Maps / Google Maps pop this kind of card on hover and reserve the
 * full PlaceDetailsCard for click; we mirror that pattern so POIs on
 * the `poi_icon` layer are discoverable without experimentally clicking.
 *
 * Preview-only: no buttons, no directions / save affordances — the
 * click path still owns those.
 */
import React from 'react';
import { poiCategoryIconId } from './poi-icons';

export interface PoiHoverPreviewProps {
  name: string;
  subtitle?: string;
  category?: string;
  screenX: number;
  screenY: number;
}

const PoiHoverPreview: React.FC<PoiHoverPreviewProps> = ({
  name,
  subtitle,
  category,
  screenX,
  screenY,
}) => {
  const iconId = poiCategoryIconId(category);
  return (
    <div
      role="tooltip"
      aria-label="Place preview"
      data-testid="poi-hover-preview"
      style={{
        position: 'fixed',
        left: screenX + 12,
        top: screenY + 12,
        zIndex: 20,
        pointerEvents: 'none',
      }}
      className="max-w-[260px] rounded-xl border border-border/40 bg-card/95 px-3 py-2 shadow-m4 backdrop-blur"
    >
      <div className="flex items-center gap-2">
        {iconId ? (
          <img
            src={`/sprites/source/${iconId}.svg`}
            alt=""
            aria-hidden="true"
            className="h-4 w-4 shrink-0 opacity-80"
          />
        ) : (
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full bg-primary"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight text-foreground">
            {name}
          </div>
          {subtitle && (
            <div className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PoiHoverPreview;
