/**
 * Directions panel — Apple Maps-style routing UI.
 *
 * Owns: mode toggle, reorderable From / To pills, Add Stop, Now / Avoid
 * dropdowns, alternates list, turn-by-turn list, one-shot TTS readout,
 * and the "Recent directions" section. Routing is handled by
 * `useDirections`; map drawing is delegated to MapsPage through the
 * `onRoutesChanged` / `onFitToCoords` callbacks so this file never
 * touches MapLibre directly.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bike,
  Car,
  Footprints,
  GripVertical,
  Loader2,
  MapPin,
  Mic2,
  Plus,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ViewportCenter } from './SearchPanel';
import PlaceAutocomplete from './PlaceAutocomplete';
import AvoidMenu from './AvoidMenu';
import DepartMenu from './DepartMenu';
import RouteAltCard from './RouteAltCard';
import TurnByTurnList from './TurnByTurnList';
import { useDirections } from './use-directions';
import { prefersMetric } from './format';
import type { ModeId, RouteAlt, WaypointRow } from './DirectionsPanel.types';
import type { PlaceResult } from '../types';
import {
  loadDirectionsRecents,
  pushDirectionsRecent,
  type DirectionsRecent,
} from '../recents';
import { VoiceStreamer } from '@/utils/VoiceStreamer';

export interface DirectionsPanelProps {
  toPlace: PlaceResult | null;
  fromPlace?: PlaceResult | null;
  initialMode?: ModeId;
  viewportCenter: ViewportCenter | null;
  onClose: () => void;
  /** Fired whenever the alternates or selection change. */
  onRoutesChanged: (alts: RouteAlt[], selectedIdx: number) => void;
  /** Fired when a turn-by-turn row is clicked — zoom the map to fit. */
  onFitToCoords: (coords: [number, number][]) => void;
}

const MODES: { id: ModeId; label: string; Icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'auto', label: 'Drive', Icon: Car },
  { id: 'pedestrian', label: 'Walk', Icon: Footprints },
  { id: 'bicycle', label: 'Cycle', Icon: Bike },
];

const DirectionsPanel: React.FC<DirectionsPanelProps> = ({
  toPlace,
  fromPlace = null,
  initialMode = 'auto',
  viewportCenter,
  onClose,
  onRoutesChanged,
  onFitToCoords,
}) => {
  const d = useDirections({ to: toPlace, from: fromPlace, mode: initialMode });
  const useMetric = useMemo(() => prefersMetric(), []);

  const [activeStepIdx, setActiveStepIdx] = useState<number | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsError, setTtsError] = useState('');
  const streamerRef = useRef<VoiceStreamer | null>(null);

  const [directionsRecents, setDirectionsRecents] = useState<DirectionsRecent[]>(
    () => loadDirectionsRecents(),
  );

  // "My location" seed — only when the From row is empty and the user
  // grants permission. Any denial leaves the row blank; the user can
  // still type.
  useEffect(() => {
    if (d.rows[0]?.place || d.rows[0]?.text) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const place: PlaceResult = {
          place_id: 'my-location',
          title: 'My Location',
          subtitle: `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`,
          address_lines: ['My Location'],
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          kind: 'current-location',
        };
        d.resolveRow(d.rows[0].rid, place);
      },
      () => { /* ignore — panel just starts blank */ },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60_000 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push alternates and selection to the map every time either changes.
  useEffect(() => {
    onRoutesChanged(d.alternates, d.selectedIdx);
  }, [d.alternates, d.selectedIdx, onRoutesChanged]);

  // Persist a directions recent once we have a resolved From and To.
  const lastRecentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (d.alternates.length === 0) return;
    const from = d.rows[0]?.place;
    const to = d.rows[d.rows.length - 1]?.place;
    if (!from || !to) return;
    const key = `${from.place_id}->${to.place_id}:${d.mode}`;
    if (lastRecentKeyRef.current === key) return;
    lastRecentKeyRef.current = key;
    setDirectionsRecents(pushDirectionsRecent({ from, to, mode: d.mode }));
  }, [d.alternates, d.rows, d.mode]);

  const selected: RouteAlt | null = d.alternates[d.selectedIdx] ?? null;

  const handleStepClick = useCallback(
    (idx: number) => {
      const step = selected?.maneuvers[idx];
      if (!step || !selected) return;
      setActiveStepIdx(idx);
      const start = Math.max(0, Math.min(step.begin_shape_index, step.end_shape_index));
      const end = Math.min(
        selected.coords.length - 1,
        Math.max(step.begin_shape_index, step.end_shape_index),
      );
      const slice = selected.coords.slice(start, end + 1);
      if (slice.length > 0) onFitToCoords(slice);
    },
    [onFitToCoords, selected],
  );

  const handleReadDirections = useCallback(async () => {
    if (!selected || selected.instructions_text.length === 0) return;
    const text = selected.instructions_text.join(', ');
    setTtsBusy(true);
    setTtsError('');
    try {
      if (!streamerRef.current) streamerRef.current = new VoiceStreamer();
      await streamerRef.current.stream(text);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
      setTtsError(e instanceof Error ? e.message : 'Voice readout failed');
    } finally {
      setTtsBusy(false);
    }
  }, [selected]);

  const handleStopReading = useCallback(() => {
    streamerRef.current?.stop();
    setTtsBusy(false);
  }, []);

  useEffect(() => () => streamerRef.current?.stop(), []);

  return (
    <section
      role="tabpanel"
      aria-label="Directions"
      className="flex h-full w-full flex-col gap-3 overflow-hidden p-4"
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

      <ModeToggle mode={d.mode} onChange={d.setMode} />

      <WaypointForm
        rows={d.rows}
        viewportCenter={viewportCenter}
        onTextChange={d.setRowText}
        onResolve={d.resolveRow}
        onSwap={d.swapRows}
        onRemove={d.removeRow}
        onAdd={d.addWaypoint}
      />

      <div className="flex flex-wrap items-center gap-2">
        <DepartMenu />
        <AvoidMenu value={d.avoid} onChange={d.setAvoid} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
        {d.error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
          >
            {d.error}
          </div>
        )}

        {d.offline && (
          <div className="rounded-md border border-border/40 bg-card/60 px-3 py-2 text-xs text-muted-foreground">
            No installed region covers this route. Install a region to route
            here offline.
          </div>
        )}

        {d.isLoading && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> Finding routes…
          </div>
        )}

        {!d.isLoading && d.alternates.length === 0 && !d.error && !d.offline && (
          <div className="rounded-md border border-dashed border-border/40 bg-card/30 px-3 py-6 text-center text-xs text-muted-foreground">
            Choose a From and To to see routes.
          </div>
        )}

        {d.alternates.length > 0 && (
          <div
            role="listbox"
            aria-label="Route alternatives"
            className="flex flex-col gap-2"
          >
            {d.alternates.map((alt, idx) => (
              <RouteAltCard
                key={idx}
                alt={alt}
                idx={idx}
                selected={idx === d.selectedIdx}
                onSelect={d.select}
                useMetric={useMetric}
              />
            ))}
          </div>
        )}

        {selected && selected.maneuvers.length > 0 && (
          <TurnByTurnList
            maneuvers={selected.maneuvers}
            activeIdx={activeStepIdx}
            onSelect={handleStepClick}
            useMetric={useMetric}
          />
        )}

        {directionsRecents.length > 0 && (
          <RecentDirectionsList recents={directionsRecents} />
        )}
      </div>

      {selected && selected.instructions_text.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={ttsBusy ? 'secondary' : 'default'}
              className="flex-1 rounded-full"
              onClick={ttsBusy ? handleStopReading : handleReadDirections}
            >
              {ttsBusy ? (
                <span className="flex items-center justify-center gap-2">
                  <Square size={12} /> Stop
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <Mic2 size={12} /> Read directions
                </span>
              )}
            </Button>
          </div>
          {ttsError && (
            <div role="alert" className="text-[11px] text-destructive">
              {ttsError}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

// ── Mode toggle ────────────────────────────────────────────────────

const ModeToggle: React.FC<{ mode: ModeId; onChange: (m: ModeId) => void }> = ({
  mode,
  onChange,
}) => (
  <div
    role="radiogroup"
    aria-label="Travel mode"
    className="grid grid-cols-3 gap-1 rounded-full border border-border/30 bg-card/40 p-1"
  >
    {MODES.map(({ id, label, Icon }) => (
      <button
        key={id}
        type="button"
        role="radio"
        aria-checked={mode === id}
        aria-label={label}
        onClick={() => onChange(id)}
        className={cn(
          'flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors',
          mode === id
            ? 'bg-primary/20 text-primary'
            : 'text-muted-foreground hover:bg-card',
        )}
      >
        <Icon size={14} />
        <span>{label}</span>
      </button>
    ))}
  </div>
);

// ── Form rows ──────────────────────────────────────────────────────

interface WaypointFormProps {
  rows: WaypointRow[];
  viewportCenter: ViewportCenter | null;
  onTextChange: (rid: string, text: string) => void;
  onResolve: (rid: string, place: PlaceResult) => void;
  onSwap: (a: number, b: number) => void;
  onRemove: (rid: string) => void;
  onAdd: () => void;
}

const WaypointForm: React.FC<WaypointFormProps> = ({
  rows,
  viewportCenter,
  onTextChange,
  onResolve,
  onSwap,
  onRemove,
  onAdd,
}) => {
  const dragIdxRef = useRef<number | null>(null);

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/30 bg-card/40 p-2">
      {rows.map((row, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === rows.length - 1;
        return (
          <div
            key={row.rid}
            draggable
            onDragStart={() => { dragIdxRef.current = idx; }}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={() => {
              const from = dragIdxRef.current;
              dragIdxRef.current = null;
              if (from != null && from !== idx) onSwap(from, idx);
            }}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5',
              'hover:bg-card/50',
            )}
            data-testid={`wp-row-${idx}`}
          >
            <span
              aria-hidden
              className={cn(
                'flex h-3 w-3 shrink-0 items-center justify-center rounded-full',
                isFirst && 'bg-primary/60',
                !isFirst && !isLast && 'bg-muted-foreground/60',
                isLast && 'bg-destructive',
              )}
            />
            <PlaceAutocomplete
              value={row.text}
              onTextChange={(t) => onTextChange(row.rid, t)}
              onResolve={(p) => onResolve(row.rid, p)}
              viewportCenter={viewportCenter}
              placeholder={isFirst ? 'From' : isLast ? 'To' : 'Stop'}
              ariaLabel={isFirst ? 'From' : isLast ? 'To' : `Stop ${idx}`}
            />
            {rows.length > 2 && !isFirst && !isLast && (
              <button
                type="button"
                aria-label={`Remove stop ${idx}`}
                onClick={() => onRemove(row.rid)}
                className="rounded p-1 text-muted-foreground hover:bg-card hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            )}
            <button
              type="button"
              aria-label={`Reorder row ${idx + 1}`}
              className="cursor-grab rounded p-1 text-muted-foreground hover:bg-card active:cursor-grabbing"
              onClick={() => {
                // Clicking the handle on row 0 swaps with row 1 (quick
                // reverse for keyboard / touch users who can't drag).
                if (idx === 0 && rows.length >= 2) onSwap(0, 1);
                else if (idx === rows.length - 1 && rows.length >= 2) {
                  onSwap(idx, idx - 1);
                }
              }}
            >
              <GripVertical size={12} />
            </button>
          </div>
        );
      })}
      {rows.length < 5 && (
        <button
          type="button"
          onClick={onAdd}
          className="mt-1 flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
        >
          <Plus size={12} /> Add Stop
        </button>
      )}
    </div>
  );
};

// ── Recent directions list ─────────────────────────────────────────

const RecentDirectionsList: React.FC<{ recents: DirectionsRecent[] }> = ({
  recents,
}) => (
  <div className="mt-2 flex flex-col gap-1">
    <div className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
      Recent directions
    </div>
    <ul className="flex flex-col divide-y divide-border/20 overflow-y-auto rounded-xl border border-border/30 bg-card/30">
      {recents.slice(0, 5).map((r) => {
        const url = buildDirectionsUrl(r);
        return (
          <li key={r.id}>
            <a
              href={url}
              className="flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-card"
            >
              <MapPin size={12} className="shrink-0 text-muted-foreground" />
              <span className="truncate">
                {r.from.title} → {r.to.title}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  </div>
);

function buildDirectionsUrl(r: DirectionsRecent): string {
  const params = new URLSearchParams({
    from: `${r.from.lat},${r.from.lon}`,
    to: `${r.to.lat},${r.to.lon}`,
    mode: r.mode,
  });
  return `/maps?${params.toString()}`;
}

export default DirectionsPanel;
