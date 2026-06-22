/**
 * Frontend client + lightweight subscription store for saved map pins.
 *
 * The backend at `/api/maps/pins` is the source of truth; this
 * module fetches once, caches in memory, and notifies subscribers when
 * the cache changes. Components consume via the `useSavedPins` hook.
 */
import { useEffect, useState } from "react";

import type { PinColor, SavedPin } from "./types";

const PINS_URL = "/api/maps/pins";

type Listener = (pins: SavedPin[]) => void;

let cache: SavedPin[] | null = null;
let pending: Promise<SavedPin[]> | null = null;
const listeners = new Set<Listener>();

function notify(pins: SavedPin[]): void {
  cache = pins;
  listeners.forEach((listener) => listener(pins));
}

export async function fetchPins(): Promise<SavedPin[]> {
  if (cache !== null) return cache;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch(PINS_URL);
    if (!response.ok) throw new Error(`pins fetch ${response.status}`);
    const body = (await response.json()) as { pins: SavedPin[] };
    const next = Array.isArray(body.pins) ? body.pins : [];
    notify(next);
    return next;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export async function createPin(input: {
  label: string;
  lat: number;
  lon: number;
  color: PinColor;
  place_ref?: SavedPin["place_ref"];
  notes?: string | null;
  collection_id?: string | null;
}): Promise<SavedPin> {
  const response = await fetch(PINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`pin create ${response.status}`);
  }
  const pin = (await response.json()) as SavedPin;
  notify([pin, ...(cache ?? [])]);
  return pin;
}

export async function updatePin(
  pinId: string,
  patch: { notes?: string | null; notes_clear?: boolean },
): Promise<SavedPin> {
  const response = await fetch(`${PINS_URL}/${encodeURIComponent(pinId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`pin update ${response.status}`);
  const pin = (await response.json()) as SavedPin;
  notify((cache ?? []).map((p) => (p.pin_id === pinId ? pin : p)));
  return pin;
}

export async function deletePin(pinId: string): Promise<void> {
  const response = await fetch(`${PINS_URL}/${encodeURIComponent(pinId)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`pin delete ${response.status}`);
  }
  notify((cache ?? []).filter((p) => p.pin_id !== pinId));
}

export function subscribePins(listener: Listener): () => void {
  listeners.add(listener);
  if (cache !== null) listener(cache);
  return () => {
    listeners.delete(listener);
  };
}

export function _resetPinsCacheForTests(): void {
  cache = null;
  pending = null;
  listeners.clear();
}

export function useSavedPins(): { pins: SavedPin[]; loading: boolean; error: string | null } {
  const [pins, setPins] = useState<SavedPin[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const unsubscribe = subscribePins((next) => {
      if (live) setPins(next);
    });
    if (cache === null) {
      fetchPins()
        .catch((err) => {
          if (live) setError(err instanceof Error ? err.message : "pin fetch failed");
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    } else {
      setLoading(false);
    }
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return { pins, loading, error };
}
