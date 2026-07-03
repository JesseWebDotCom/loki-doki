/**
 * Saved pins panel — list, create, delete.
 *
 * Net-new in chunk 04; the panel is reachable from the LeftRail and
 * persists through `/api/maps/pins`. Storage is server-side; this
 * component only renders the cache and calls the helpers in `pins.ts`.
 */
import { useState, useEffect } from "react";
import { ClockIcon, FolderPlusIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { cn } from "@/lib/cn";

import { createPin, deletePin, updatePin, useSavedPins } from "../pins";
import { useUserLocation } from "../use-user-location";
import { PIN_COLORS, type PinColor, type PlaceResult, type SavedPin } from "../types";

interface PinCollection { id: string; name: string; color: string; created_at: string; }

async function fetchCollections(): Promise<PinCollection[]> {
  try {
    const r = await fetch("/api/maps/collections");
    if (!r.ok) return [];
    const d = await r.json() as { collections: PinCollection[] };
    return d.collections ?? [];
  } catch { return []; }
}

async function createCollection(name: string): Promise<PinCollection | null> {
  try {
    const r = await fetch("/api/maps/collections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) return null;
    return await r.json() as PinCollection;
  } catch { return null; }
}

// Fixed, distinct swatch hues so saved pins stay visually distinguishable:
// a color picker's palette, not a UI accent; kept as literal colors on
// purpose (mirrors poi-colors.ts / category-icons.tsx reasoning).
// design-ok(raw-palette-semantic): pin color swatch data, mirrors poi-colors.ts/category-icons.tsx
const COLOR_DOT: Record<PinColor, string> = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-brand",
  // design-ok(raw-palette-semantic): pin color swatch data, mirrors poi-colors.ts/category-icons.tsx
  pink: "bg-pink-500",
  gray: "bg-zinc-500",
};

export interface PinsPanelProps {
  /**
   * Seed for the "create from current view" form. When the user has a
   * selected place, prefer that; otherwise fall back to the map center.
   */
  seedPlace?: PlaceResult | null;
  seedCenter?: { lat: number; lon: number } | null;
  onSelect?: (pin: SavedPin) => void;
}

export function PinsPanel({
  seedPlace,
  seedCenter,
  onSelect,
}: PinsPanelProps): JSX.Element {
  const { pins, loading, error } = useSavedPins();
  const userLocation = useUserLocation();
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [color, setColor] = useState<PinColor>("red");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [etaResults, setEtaResults] = useState<Record<string, string>>({});
  const [collections, setCollections] = useState<PinCollection[]>([]);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [confirmDeletePinId, setConfirmDeletePinId] = useState<string | null>(null);

  useEffect(() => { void fetchCollections().then(setCollections); }, []);

  const seedLat = seedPlace?.lat ?? seedCenter?.lat ?? null;
  const seedLon = seedPlace?.lon ?? seedCenter?.lon ?? null;
  const canCreate = seedLat !== null && seedLon !== null && label.trim().length > 0 && !busy;

  async function onCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canCreate || seedLat === null || seedLon === null) return;
    setBusy(true);
    setFormError(null);
    try {
      await createPin({
        label: label.trim(),
        lat: seedLat,
        lon: seedLon,
        color,
        place_ref: seedPlace ?? null,
        notes: notes.trim() || null,
        collection_id: selectedCollectionId,
      });
      setLabel("");
      setNotes("");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save pin");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(pinId: string): Promise<void> {
    try {
      await deletePin(pinId);
    } catch {
      // Swallow — the optimistic delete already removed it from cache
      // for the user; the next fetch will reconcile.
    }
  }

  async function onEta(pin: SavedPin): Promise<void> {
    const loc = userLocation.location;
    if (!loc) {
      setEtaResults((r) => ({ ...r, [pin.pin_id]: "Location unavailable" }));
      return;
    }
    setEtaResults((r) => ({ ...r, [pin.pin_id]: "…" }));
    try {
      const res = await fetch(
        `/api/maps/eta?from=${loc.lat},${loc.lon}&to=${pin.lat},${pin.lon}`,
      );
      if (!res.ok) throw new Error("ETA unavailable");
      const data = (await res.json()) as { duration_s: number; distance_m: number };
      const mins = Math.round(data.duration_s / 60);
      const km = (data.distance_m / 1000).toFixed(1);
      setEtaResults((r) => ({ ...r, [pin.pin_id]: `${mins} min · ${km} km` }));
    } catch {
      setEtaResults((r) => ({ ...r, [pin.pin_id]: "ETA unavailable" }));
    }
  }

  async function onSaveNotes(pin: SavedPin, newNotes: string): Promise<void> {
    try {
      await updatePin(pin.pin_id, { notes: newNotes.trim() || null, notes_clear: !newNotes.trim() });
    } catch {
      // Swallow — transient failure; user can retry.
    }
  }

  return (
    <section
      role="tabpanel"
      aria-label="Saved pins"
      className="grid gap-3"
    >
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Saved pins</h2>

      <form onSubmit={(e) => void onCreate(e)} className="grid gap-2 rounded-card border border-border/60 bg-card/60 p-3">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Label
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={seedPlace?.title ?? "New pin"}
            aria-label="Pin label"
          />
        </label>
        <fieldset className="grid gap-1 text-xs text-muted-foreground">
          <legend className="px-0">Color</legend>
          <div role="radiogroup" aria-label="Pin color" className="flex flex-wrap gap-2">
            {PIN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                className={cn(
                  "size-6 rounded-full border-2 transition-colors",
                  COLOR_DOT[c],
                  c === color ? "border-foreground" : "border-transparent",
                )}
              />
            ))}
          </div>
        </fieldset>
        {collections.length > 0 && (
          <label className="grid gap-1 text-xs text-muted-foreground">
            Collection
            <select value={selectedCollectionId ?? ""} onChange={(e) => setSelectedCollectionId(e.target.value || null)}
              className="rounded-control border border-input bg-transparent px-3 py-1.5 text-sm">
              <option value="">Saved (no collection)</option>
              {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-xs text-muted-foreground">
          Notes (optional)
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any notes about this place…"
            rows={2}
            className="w-full resize-none rounded-control border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
        <div className="text-xs text-muted-foreground">
          {seedPlace
            ? `Anchor: ${seedPlace.title}`
            : seedLat !== null && seedLon !== null
              ? `Anchor: map center (${seedLat.toFixed(4)}, ${seedLon.toFixed(4)})`
              : "Move the map or pick a place to choose an anchor."}
        </div>
        <Button type="submit" disabled={!canCreate}>
          {busy ? (
            <Spinner size="sm" className="mr-2 text-primary-foreground" />
          ) : (
            <PlusIcon className="mr-2 size-4" />
          )}
          Save pin
        </Button>
      </form>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}

      <div className="flex items-center gap-2">
        <Input value={newCollectionName} onChange={(e) => setNewCollectionName(e.target.value)}
          placeholder="New collection name…" className="h-8 text-xs" />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Create collection" title="Create collection"
          className="text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={async () => {
            if (!newCollectionName.trim()) return;
            const c = await createCollection(newCollectionName.trim());
            if (c) { setCollections((prev) => [...prev, c]); setNewCollectionName(""); }
          }}>
          <FolderPlusIcon className="size-4" />
        </Button>
      </div>

      <ul className="grid gap-2" aria-label="Saved pins list">
        {pins.length === 0 && !loading ? (
          <li className="rounded-card border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
            No pins yet. Create one from the form above.
          </li>
        ) : null}
        {pins.map((pin) => (
          <li key={pin.pin_id} className="grid gap-1 rounded-card border border-border/60 bg-card/70 px-3 py-2">
            <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2">
              <span className={cn("size-3 rounded-full", COLOR_DOT[pin.color] ?? COLOR_DOT.gray)} aria-hidden />
              <button type="button" onClick={() => onSelect?.(pin)} className="grid min-w-0 text-left">
                <span className="truncate text-sm font-medium">{pin.label}</span>
                <span className="truncate text-xs text-muted-foreground">{pin.lat.toFixed(4)}, {pin.lon.toFixed(4)}</span>
              </button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`ETA to ${pin.label}`} title="ETA from here"
                className="text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void onEta(pin)}>
                <ClockIcon className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete pin ${pin.label}`}
                className="text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setConfirmDeletePinId(pin.pin_id)}>
                <Trash2Icon className="size-4" />
              </Button>
            </div>
            {etaResults[pin.pin_id] ? (
              <p className="pl-5 text-xs text-muted-foreground">{etaResults[pin.pin_id]}</p>
            ) : null}
            <textarea
              defaultValue={pin.notes ?? ""}
              placeholder="Add a note…"
              rows={1}
              onBlur={(e) => void onSaveNotes(pin, e.currentTarget.value)}
              className="ml-5 w-[calc(100%-1.25rem)] resize-none rounded-control border-0 bg-transparent px-2 py-1 text-xs text-muted-foreground placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            />
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={confirmDeletePinId !== null}
        onOpenChange={open => !open && setConfirmDeletePinId(null)}
        title="Delete this pin?"
        description="This will permanently remove the saved pin. This action cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDeletePinId) { void onDelete(confirmDeletePinId); setConfirmDeletePinId(null) } }}
      />
    </section>
  );
}
