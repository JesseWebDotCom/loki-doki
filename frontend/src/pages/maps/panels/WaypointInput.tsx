import { TrashIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

import { searchPlaces, type ViewportCenter } from "../api";
import type { WaypointRow } from "../use-directions";
import type { PlaceResult } from "../types";

const SEARCH_DEBOUNCE_MS = 300;

export function WaypointInput({
  row,
  index,
  isLast,
  viewportCenter,
  onResolve,
  onRemove,
}: {
  row: WaypointRow;
  index: number;
  isLast: boolean;
  viewportCenter: ViewportCenter | null;
  onResolve: (place: PlaceResult | null) => void;
  onRemove: () => void;
}): JSX.Element {
  const [text, setText] = useState(row.place?.title ?? "");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [cursor, setCursor] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep text in sync if the row was populated externally (deep-link, swap, …).
  useEffect(() => {
    if (row.place?.title && row.place.title !== text) {
      setText(row.place.title);
      setOpen(false);
    }
  }, [row.place]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = text.trim();
    if (!trimmed || (row.place && row.place.title === trimmed)) {
      setResults([]);
      setCursor(-1);
      return;
    }
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      searchPlaces(trimmed, viewportCenter, controller.signal)
        .then((response) => {
          setResults(response.results);
          setOpen(response.results.length > 0);
          setCursor(response.results.length > 0 ? 0 : -1);
        })
        .catch(() => {
          // ignore — autocomplete is best-effort
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text, viewportCenter, row.place]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function pick(place: PlaceResult): void {
    setText(place.title);
    setOpen(false);
    setResults([]);
    onResolve(place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!open || results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (c <= 0 ? results.length - 1 : c - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = results[cursor >= 0 ? cursor : 0];
      if (choice) pick(choice);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  const label = row.isOrigin ? "From" : isLast ? "To" : `Stop ${index}`;
  const placeholder = row.isOrigin ? "Origin" : isLast ? "Destination" : "Stop";

  return (
    <div className="grid gap-1">
      <label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            if (row.place) onResolve(null);
          }}
          onKeyDown={onKeyDown}
        />
        {!row.isOrigin && !isLast ? (
          <Button type="button" size="icon" variant="outline" onClick={onRemove} aria-label="Remove stop">
            <TrashIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      {open && results.length > 0 ? (
        <ul role="listbox" className="grid gap-1 rounded-card border border-border/70 bg-card/95 p-1">
          {results.map((place, i) => (
            <li key={place.place_id}>
              <button
                type="button"
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(place)}
                className={cn(
                  "w-full rounded-control px-3 py-2 text-left text-sm",
                  i === cursor ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
              >
                <div className="font-medium">{place.title}</div>
                {place.subtitle ? <div className="text-xs text-muted-foreground">{place.subtitle}</div> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
