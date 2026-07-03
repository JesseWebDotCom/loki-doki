import {
  ArrowUpDownIcon,
  BikeIcon,
  CarFrontIcon,
  FootprintsIcon,
  MountainIcon,
  PlusIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

import type { ViewportCenter } from "../api";
import type { ManeuverView, RouteAlt } from "../use-directions";
import { useDirections, type DirectionsMode } from "../use-directions";
import { useRouteReadout } from "../use-route-readout";
import { pushDirectionsRecent } from "../recents";
import type { PlaceResult } from "../types";
import { computeRouteBbox, decodeGeometry } from "../route-layer";
import { searchPlaces } from "../api";
import { useMapPrefs } from "../use-map-prefs";
import { WaypointInput } from "./WaypointInput";

function describeMode(mode: DirectionsMode): string {
  if (mode === "pedestrian") return "Walk";
  if (mode === "bicycle") return "Bike";
  if (mode === "hiking") return "Hiking";
  if (mode === "mtb") return "MTB";
  return "Drive";
}

function formatDuration(durationS: number): string {
  const minutes = Math.max(1, Math.round(durationS / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  return rem === 0 ? `${hours} h` : `${hours} h ${rem} m`;
}

function formatDistance(distanceM: number, units: "metric" | "imperial" = "metric"): string {
  if (units === "imperial") {
    const miles = distanceM / 1609.34;
    if (miles < 0.1) return `${Math.round(distanceM * 3.28084)} ft`;
    return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
  }
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;
  return `${(distanceM / 1000).toFixed(distanceM < 10_000 ? 1 : 0)} km`;
}

export interface DirectionsPanelProps {
  destination?: PlaceResult | null;
  origin?: PlaceResult | null;
  mode?: DirectionsMode;
  viewportCenter: ViewportCenter | null;
  onClose: () => void;
  onAltsChange: (alts: RouteAlt[], selectedIdx: number) => void;
  onStepFocus: (coords: [number, number][] | null) => void;
  onStartNavigation?: (route: RouteAlt) => void;
}

export function DirectionsPanel({
  destination,
  origin,
  mode,
  viewportCenter,
  onAltsChange,
  onStepFocus,
  onStartNavigation,
}: DirectionsPanelProps): JSX.Element {
  const { prefs, setPref } = useMapPrefs();
  const initialDifficultyCap = mode === "hiking" ? prefs.hikingMaxRating : mode === "mtb" ? prefs.mtbMaxRating : null;
  const dirs = useDirections({
    from: origin ?? null,
    to: destination ?? null,
    mode,
    initialAvoid: { highways: prefs.avoidHighways, tolls: prefs.avoidTolls, ferries: prefs.avoidFerries },
    initialDifficultyCap,
  });
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(null);
  const recentsPushed = useRef<string | null>(null);

  useEffect(() => {
    onAltsChange(dirs.alternates, dirs.selectedIdx);
  }, [dirs.alternates, dirs.selectedIdx, onAltsChange]);

  // Record a directions-recent the first time a route lands for a given (from,to,mode) tuple.
  useEffect(() => {
    if (dirs.alternates.length === 0) return;
    const resolved = dirs.rows.filter((r) => r.place != null);
    if (resolved.length < 2) return;
    const from = resolved[0].place!;
    const to = resolved[resolved.length - 1].place!;
    const key = `${from.place_id}->${to.place_id}:${dirs.mode}`;
    if (recentsPushed.current === key) return;
    recentsPushed.current = key;
    pushDirectionsRecent({ from, to, mode: dirs.mode });
  }, [dirs.alternates, dirs.mode, dirs.rows]);

  const primary = dirs.alternates[dirs.selectedIdx] as RouteAlt | undefined;
  const instructions = primary?.instructions_text ?? [];
  const readout = useRouteReadout(instructions);
  const [routeCategory, setRouteCategory] = useState<string | null>(null);
  const [routePois, setRoutePois] = useState<PlaceResult[]>([]);
  useEffect(() => {
    if (!primary || !routeCategory) { setRoutePois([]); return; }
    const coords = decodeGeometry(primary.geometry);
    const bbox = computeRouteBbox(coords);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const vc = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
    void searchPlaces("", vc, new AbortController().signal, { category: routeCategory })
      .then(({ results }) => setRoutePois(results.slice(0, 5)))
      .catch(() => setRoutePois([]));
  }, [primary, routeCategory]);

  const handleStepClick = useCallback(
    (alt: RouteAlt, step: ManeuverView, key: string) => {
      setSelectedStepKey(key);
      const [a, b] = step.interval;
      if (alt.coords.length === 0 || a >= b) {
        onStepFocus(null);
        return;
      }
      const slice = alt.coords.slice(Math.max(0, a), Math.min(alt.coords.length, b + 1));
      onStepFocus(slice);
    },
    [onStepFocus],
  );

  return (
    <section
      role="tabpanel"
      aria-label="Directions"
      className="grid gap-4"
    >
      <ModePicker mode={dirs.mode} onChange={(m) => {
        dirs.setMode(m);
        if (m === "hiking" || m === "mtb") {
          dirs.setDifficultyCap(m === "hiking" ? prefs.hikingMaxRating : prefs.mtbMaxRating);
        }
      }} />
      {(dirs.mode === "hiking" || dirs.mode === "mtb") && (
        <DifficultyPicker
          mode={dirs.mode}
          value={dirs.difficultyCap ?? (dirs.mode === "hiking" ? prefs.hikingMaxRating : prefs.mtbMaxRating)}
          onChange={(v) => {
            dirs.setDifficultyCap(v);
            setPref(dirs.mode === "hiking" ? "hikingMaxRating" : "mtbMaxRating", v);
          }}
        />
      )}

      <div className="grid gap-2">
        {dirs.rows.map((row, index) => (
          <WaypointInput
            key={row.rid}
            row={row}
            index={index}
            isLast={index === dirs.rows.length - 1}
            viewportCenter={viewportCenter}
            onResolve={(place) => dirs.setRowPlace(row.rid, place)}
            onRemove={() => dirs.removeRow(row.rid)}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={dirs.swapEndpoints}>
            <ArrowUpDownIcon className="mr-1 size-4" />
            Swap
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={dirs.addWaypoint}>
            <PlusIcon className="mr-1 size-4" />
            Add stop
          </Button>
        </div>
      </div>

      {dirs.isLoading ? (
        <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          Routing…
        </p>
      ) : null}

      {dirs.unavailable ? (
        <p className="rounded-card border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          {dirs.error ?? "Routing unavailable for this region."}
        </p>
      ) : dirs.error ? (
        <p className="text-xs text-destructive">{dirs.error}</p>
      ) : null}

      {dirs.alternates.length > 0 ? (
        <div className="grid gap-2">
          {dirs.alternates.map((alt, idx) => (
            <AlternateRow
              key={`alt-${idx}-${alt.geometry.slice(0, 8)}`}
              alt={alt}
              selected={idx === dirs.selectedIdx}
              modeLabel={describeMode(dirs.mode)}
              units={prefs.units}
              onSelect={() => dirs.setSelectedIdx(idx)}
            />
          ))}
        </div>
      ) : null}

      {primary && (
        <div className="flex flex-wrap gap-1.5">
          {(["gas_station","restaurant","cafe","atm","hotel","parking"] as const).map((cat) => (
            <button key={cat} type="button"
              onClick={() => setRouteCategory(routeCategory === cat ? null : cat)}
              className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                routeCategory === cat ? "border-primary/40 bg-primary/10 text-primary" : "border-border/60 bg-card/60 text-muted-foreground hover:text-foreground"
              )}>
              {cat.replace("_", " ")}
            </button>
          ))}
        </div>
      )}
      {routePois.length > 0 && (
        <ul className="grid gap-1">
          {routePois.map((p) => (
            <li key={p.place_id} className="flex items-baseline justify-between gap-2 rounded-control px-2 py-1.5 text-xs bg-card/60 border border-border/40">
              <span className="truncate font-medium">{p.title}</span>
              <span className="shrink-0 text-muted-foreground">{p.distance_m ? `${(p.distance_m / 1000).toFixed(1)} km` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {primary && primary.maneuvers.length > 0 ? (
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Turn-by-turn</p>
            <div className="flex gap-1.5">
            {onStartNavigation && (
              <Button type="button" size="sm" onClick={() => onStartNavigation(primary)}>
                Start
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant={readout.speaking ? "default" : "outline"}
              onClick={() => void readout.speak()}
              disabled={instructions.length === 0}
              aria-pressed={readout.speaking}
              data-testid="read-directions-button"
            >
              {readout.speaking ? (
                <>
                  <VolumeXIcon className="mr-1 size-4" />
                  Stop
                </>
              ) : (
                <>
                  <Volume2Icon className="mr-1 size-4" />
                  Read directions
                </>
              )}
            </Button>
            </div>
          </div>
          <ol className="grid gap-1.5">
            {primary.maneuvers.map((step, index) => {
              const key = `${dirs.selectedIdx}:${index}`;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => handleStepClick(primary, step, key)}
                    className={cn(
                      "grid w-full gap-0.5 rounded-control border border-border/60 px-3 py-2 text-left text-sm transition-colors",
                      selectedStepKey === key ? "bg-accent text-accent-foreground" : "bg-card/70 hover:bg-muted",
                    )}
                  >
                    <span className="font-medium">{step.text}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDistance(step.distance_m, prefs.units)} · {formatDuration(step.duration_s)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {primary?.mechanism_used ? (
        <p className="text-xs text-muted-foreground">
          Routed via <span className="font-medium">{primary.mechanism_used}</span>
        </p>
      ) : null}
    </section>
  );
}

function ModePicker({
  mode,
  onChange,
}: {
  mode: DirectionsMode;
  onChange: (m: DirectionsMode) => void;
}): JSX.Element {
  const options: { id: DirectionsMode; label: string; icon: JSX.Element }[] = [
    { id: "auto", label: "Drive", icon: <CarFrontIcon className="size-4" /> },
    { id: "pedestrian", label: "Walk", icon: <FootprintsIcon className="size-4" /> },
    { id: "bicycle", label: "Bike", icon: <BikeIcon className="size-4" /> },
    { id: "hiking", label: "Hike", icon: <MountainIcon className="size-4" /> },
    { id: "mtb", label: "MTB", icon: <BikeIcon className="size-4" /> },
  ];
  return (
    <div role="tablist" aria-label="Travel mode" className="flex items-center justify-between gap-1">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={mode === opt.id}
          onClick={() => onChange(opt.id)}
          className={cn(
            "flex flex-1 flex-col items-center gap-1 rounded-control px-1 py-2 transition-colors",
            mode === opt.id
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <span className="[&>svg]:size-5">{opt.icon}</span>
          <span className="text-[10px] font-medium leading-none">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

function AlternateRow({
  alt,
  selected,
  modeLabel,
  units,
  onSelect,
}: {
  alt: RouteAlt;
  selected: boolean;
  modeLabel: string;
  units: "metric" | "imperial";
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-card border px-3 py-2 text-left text-sm transition-colors",
        selected ? "border-primary bg-accent text-accent-foreground" : "border-border/60 bg-card/70 hover:bg-muted",
      )}
    >
      <div className="grid">
        <span className="font-semibold">{formatDuration(alt.duration_s)}</span>
        <span className="text-xs text-muted-foreground">
          {formatDistance(alt.distance_m, units)} · {modeLabel}
        </span>
      </div>
      {alt.is_fastest ? <Badge variant="secondary">Fastest</Badge> : null}
    </button>
  );
}

const HIKING_LEVELS = [
  { value: 2, label: "Easy" },
  { value: 3, label: "Moderate" },
  { value: 4, label: "Hard" },
  { value: 5, label: "Expert" },
] as const;

const MTB_LEVELS = [
  { value: 1, label: "Easy" },
  { value: 2, label: "Moderate" },
  { value: 3, label: "Hard" },
  { value: 5, label: "Expert" },
] as const;

function DifficultyPicker({
  mode, value, onChange,
}: { mode: "hiking" | "mtb"; value: number; onChange: (v: number) => void }): JSX.Element {
  const levels = mode === "hiking" ? HIKING_LEVELS : MTB_LEVELS;
  return (
    <div className="grid gap-1">
      <p className="text-xs text-muted-foreground">Max difficulty</p>
      <div className="grid grid-cols-4 gap-1">
        {levels.map((l) => (
          <button key={l.value} type="button" onClick={() => onChange(l.value)}
            className={cn("rounded-control border px-2 py-1 text-xs transition-colors",
              value === l.value ? "border-primary bg-primary/10 text-primary font-medium" : "border-border/60 bg-card/60 text-muted-foreground hover:text-foreground")}>
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}
