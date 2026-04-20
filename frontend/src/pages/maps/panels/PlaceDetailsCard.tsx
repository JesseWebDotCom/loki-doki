/**
 * Place-details card — opens when the user selects a search result or
 * a recents row. Structurally mirrors Apple Maps' place sheet: title
 * header, blue Directions button, Details block with address + share.
 *
 * The Directions button here is a routing *intent* — it flips the
 * rail to the Directions panel and pre-populates its "To" field with
 * this place. Real routing lands in Chunk 7.
 */
import React, { useCallback, useState } from 'react';
import { ArrowUpRight, Copy, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PlaceResult } from '../types';
import { poiCategoryIconId } from './poi-icons';

export interface PlaceDetailsCardProps {
  place: PlaceResult;
  onDirections: (place: PlaceResult) => void;
  onRegionLink?: (region: string) => void;
  category?: string;
  onClose: () => void;
}

const PlaceDetailsCard: React.FC<PlaceDetailsCardProps> = ({
  place,
  onDirections,
  onRegionLink,
  category,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  const addressText = place.address_lines.join('\n');
  const iconId = poiCategoryIconId(category);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(addressText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [addressText]);

  return (
    <section
      role="tabpanel"
      aria-label="Place details"
      className="flex h-full w-full flex-col gap-4 p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {iconId ? (
              <img
                src={`/sprites/source/${iconId}.svg`}
                alt=""
                aria-hidden="true"
                className="h-5 w-5 shrink-0 opacity-80"
              />
            ) : null}
            <h2 className="truncate text-2xl font-semibold tracking-tight">
              {place.title}
            </h2>
          </div>
          {place.subtitle && (
            <div className="mt-1 truncate text-sm text-muted-foreground">
              Address ·{' '}
              {onRegionLink ? (
                <button
                  type="button"
                  onClick={() => onRegionLink(place.subtitle)}
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground cursor-pointer"
                >
                  {place.subtitle}
                </button>
              ) : (
                <span>{place.subtitle}</span>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-card"
        >
          <X size={16} />
        </button>
      </header>

      <Button
        type="button"
        onClick={() => onDirections(place)}
        className="w-full h-11 rounded-full text-sm font-semibold shadow-m4"
      >
        Directions
      </Button>

      <div className="flex flex-col gap-2">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Details
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border/30 bg-card/60 p-3">
          <div className="flex-1 whitespace-pre-line text-sm leading-relaxed text-foreground">
            {addressText}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'Address copied' : 'Copy address'}
            className="shrink-0 rounded-full border border-border/30 bg-background p-2 text-muted-foreground hover:text-foreground hover:bg-card"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {place.lat.toFixed(5)}, {place.lon.toFixed(5)}
          <button
            type="button"
            onClick={handleCopy}
            className="ml-2 inline-flex items-center gap-1 text-primary-foreground/80 hover:text-primary-foreground"
          >
            <ArrowUpRight size={10} /> share
          </button>
        </div>
      </div>
    </section>
  );
};

export default PlaceDetailsCard;
