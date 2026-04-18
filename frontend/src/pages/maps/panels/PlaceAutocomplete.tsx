/**
 * Small reusable place-autocomplete input — shared by the Directions
 * From / To pills. Behaviour mirrors SearchPanel's dropdown (debounce,
 * keyboard nav, same backend), but framed as a text input with a popover
 * of results rather than a full panel section.
 *
 * Deliberately standalone so it can be embedded inside form rows
 * without importing SearchPanel's header / chrome.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { PlaceResult } from '../types';
import { searchPlaces, type ViewportCenter } from './SearchPanel';

const DEBOUNCE_MS = 250;
const MAX_RESULTS = 8;

export interface PlaceAutocompleteProps {
  value: string;
  onTextChange: (text: string) => void;
  onResolve: (place: PlaceResult) => void;
  viewportCenter: ViewportCenter | null;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

const PlaceAutocomplete: React.FC<PlaceAutocompleteProps> = ({
  value,
  onTextChange,
  onResolve,
  viewportCenter,
  placeholder,
  ariaLabel,
  disabled,
  className,
}) => {
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [focused, setFocused] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const fire = useCallback(
    async (q: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        setOpen(false);
        return;
      }
      try {
        const resp = await searchPlaces(trimmed, viewportCenter, controller.signal);
        setResults(resp.results.slice(0, MAX_RESULTS));
        setCursor(resp.results.length > 0 ? 0 : -1);
        setOpen(resp.results.length > 0);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setResults([]);
        setOpen(false);
      }
    },
    [viewportCenter],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!focused) return;
    if (!value.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void fire(value);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, fire, focused]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const commit = useCallback(
    (place: PlaceResult) => {
      onResolve(place);
      setOpen(false);
      setResults([]);
    },
    [onResolve],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) {
      if (e.key === 'Escape' && value) {
        onTextChange('');
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c <= 0 ? results.length - 1 : c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = results[cursor >= 0 ? cursor : 0];
      if (picked) commit(picked);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative flex-1', className)}>
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={`${ariaLabel}-listbox`}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onTextChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        className="h-8 w-full rounded-md border-none bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-0 disabled:opacity-50"
      />
      {open && results.length > 0 && (
        <ul
          id={`${ariaLabel}-listbox`}
          role="listbox"
          aria-label={`${ariaLabel} results`}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-border/40 bg-card/95 backdrop-blur shadow-m4"
        >
          {results.map((r, idx) => (
            <li key={r.place_id}>
              <button
                type="button"
                role="option"
                aria-selected={cursor === idx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(r);
                }}
                onMouseEnter={() => setCursor(idx)}
                className={cn(
                  'flex w-full flex-col items-start px-3 py-2 text-left transition-colors',
                  cursor === idx ? 'bg-primary/10' : 'hover:bg-card',
                )}
              >
                <span className="truncate text-sm font-medium text-foreground">
                  {r.title}
                </span>
                {r.subtitle && (
                  <span className="truncate text-xs text-muted-foreground">
                    {r.subtitle}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default PlaceAutocomplete;
