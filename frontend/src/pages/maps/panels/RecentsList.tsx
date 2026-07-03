/**
 * Compact recents list rendered under the Search panel and the
 * Directions panel.
 *
 * The list reads from the localStorage helpers in `recents.ts`. It does
 * not subscribe to live changes — re-mount (or a fresh selection) is
 * enough; we re-read in a `useEffect` keyed on a passed-in version so a
 * sibling panel can nudge it.
 */
import { useEffect, useState } from "react";
import { RouteIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/cn";

import { PoiIcon } from "../PoiIcon";
import {
  clearRecents,
  loadDirectionsRecents,
  loadRecents,
  removeRecent,
  type DirectionsRecent,
} from "../recents";
import type { PlaceResult, Recent } from "../types";

export interface RecentsListProps {
  variant: "places" | "directions";
  /**
   * Bump this number from the parent after a successful select/save to
   * force a re-read from localStorage.
   */
  reloadKey?: number;
  /**
   * When true, render without an outer card frame — for embedding
   * inside another panel (e.g. SearchPanel). Default false renders the
   * standalone card with a section heading.
   */
  flat?: boolean;
  onPick?: (place: PlaceResult) => void;
  onPickDirections?: (entry: DirectionsRecent) => void;
}

export function RecentsList({
  variant,
  reloadKey,
  flat = false,
  onPick,
  onPickDirections,
}: RecentsListProps): JSX.Element | null {
  const [places, setPlaces] = useState<Recent[]>([]);
  const [directions, setDirections] = useState<DirectionsRecent[]>([]);

  useEffect(() => {
    if (variant === "places") {
      setPlaces(loadRecents());
    } else {
      setDirections(loadDirectionsRecents());
    }
  }, [variant, reloadKey]);

  if (variant === "places") {
    if (places.length === 0) return null;
    const heading = flat ? null : (
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Recent
      </h3>
    );
    return (
      <section aria-label="Recent places" className="grid gap-1">
        {heading}
        <ul className="grid gap-1">
          {places.map((entry) => {
            return (
              <li key={entry.place_id} className="group/recent relative">
                <button
                  type="button"
                  onClick={() => onPick?.(entry)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-3 rounded-control px-3 py-2 pr-9 text-left",
                    "hover:bg-muted/60",
                  )}
                >
                  <PoiIcon kind={entry.kind} brand_qid={entry.brand_qid} website={entry.website} />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-sm font-medium">{entry.title}</span>
                    {entry.subtitle ? (
                      <span className="truncate text-xs text-foreground/60">{entry.subtitle}</span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove recent ${entry.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setPlaces(removeRecent(entry.place_id));
                  }}
                  className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1",
                    "text-foreground/60 opacity-0 transition-opacity",
                    "hover:bg-muted hover:text-foreground",
                    "group-hover/recent:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => {
            clearRecents();
            setPlaces([]);
          }}
          className="justify-self-start px-3 py-1 text-xs font-medium text-brand hover:text-brand-hover"
        >
          Clear Recents
        </button>
      </section>
    );
  }

  if (directions.length === 0) return null;
  const heading = flat ? null : (
    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      Recent routes
    </h3>
  );
  return (
    <section aria-label="Recent directions" className="grid gap-1">
      {heading}
      <ul className="grid gap-1">
        {directions.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onPickDirections?.(entry)}
              className={cn(
                "grid w-full min-w-0 gap-0.5 rounded-control border border-border/50 bg-card/60 px-3 py-2 text-left",
                "hover:bg-muted",
              )}
            >
              <span className="flex items-center gap-2 truncate text-sm">
                <RouteIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {entry.from.title} → {entry.to.title}
                </span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                Mode: {entry.mode}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
