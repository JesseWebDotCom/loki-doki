import { useEffect, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";

import { resolveHoverIdentity, type HoverIdentity } from "./hover";

const HOVER_LAYER_PRIORITY = [
  "poi-label",
] as const;

interface HoverTarget {
  key: string;
  name: string;
  lat: number;
  lon: number;
  tileHint: { class?: string | null; subclass?: string | null } | null;
}

// Cache resolved identities so repeat hovers over the same feature are instant.
const resolveCache = new Map<string, HoverIdentity>();

function featurePriority(layerId: string): number {
  const idx = HOVER_LAYER_PRIORITY.indexOf(layerId as (typeof HOVER_LAYER_PRIORITY)[number]);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function coordsFromFeature(
  feature: maplibregl.MapGeoJSONFeature,
): [number, number] | null {
  if (feature.geometry.type === "Point") {
    const [lon, lat] = feature.geometry.coordinates;
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
  }
  if (feature.geometry.type === "Polygon") {
    const ring = feature.geometry.coordinates[0];
    if (!ring?.length) return null;
    const lon = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length;
    const lat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length;
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
  }
  return null;
}

function featureKey(feature: maplibregl.MapGeoJSONFeature): string {
  const props = feature.properties ?? {};
  const parts = [
    feature.layer.id,
    typeof props.place_id === "string" ? props.place_id : "",
    typeof props.name === "string" ? props.name : "",
    typeof props.class === "string" ? props.class : "",
    typeof props.subclass === "string" ? props.subclass : "",
  ];
  const coords = coordsFromFeature(feature);
  if (coords) {
    parts.push(coords[0].toFixed(5), coords[1].toFixed(5));
  }
  return parts.join("|");
}

export function pickHoverTarget(
  features: maplibregl.MapGeoJSONFeature[],
  fallback: { lat: number; lon: number },
): HoverTarget | null {
  const feature = [...features].sort(
    (a, b) => featurePriority(a.layer.id) - featurePriority(b.layer.id),
  )[0];
  if (!feature) return null;
  const featureCoords = coordsFromFeature(feature);
  const [lat, lon] = featureCoords ?? [fallback.lat, fallback.lon];
  return {
    key: featureKey(feature),
    name: typeof feature.properties?.name === "string" ? feature.properties.name : "",
    lat,
    lon,
    tileHint: {
      class: typeof feature.properties?.class === "string" ? feature.properties.class : null,
      subclass:
        typeof feature.properties?.subclass === "string" ? feature.properties.subclass : null,
    },
  };
}

export function useHoverWire(
  mapRef: MutableRefObject<maplibregl.Map | null>,
  setHover: (identity: HoverIdentity | null) => void,
  setHoverLngLat: (lngLat: [number, number] | null) => void,
): void {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let hoverTimer: number | null = null;
    let requestId = 0;
    let abortController: AbortController | null = null;
    // Key of the feature whose resolve has completed and card is visible.
    let resolvedTargetKey: string | null = null;
    // Key of the feature currently being resolved (in-flight).
    let pendingTargetKey: string | null = null;

    const onMove = (event: maplibregl.MapMouseEvent) => {
      if (hoverTimer !== null) window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => {
        if (!map.isStyleLoaded()) return;
        const hoverLayers = [
          "poi-label",
        ].filter((layerId) => Boolean(map.getLayer(layerId)));
        if (hoverLayers.length === 0) return;
        const raw = map.queryRenderedFeatures(event.point, { layers: hoverLayers });
        const nonCluster = raw.filter((f) => !f.properties?.point_count);
        const target = pickHoverTarget(nonCluster, { lat: event.lngLat.lat, lon: event.lngLat.lng });

        // No feature — card stays visible until a different feature is hit or
        // the mouse leaves the map container.
        if (!target) return;

        // Same feature already resolved or currently resolving — nothing to do.
        if (target.key === resolvedTargetKey || target.key === pendingTargetKey) return;

        // New feature: cancel previous resolve and start fresh.
        abortController?.abort();
        abortController = new AbortController();
        pendingTargetKey = target.key;
        resolvedTargetKey = null;

        // Show immediately from cache or tile data — no waiting.
        const cached = resolveCache.get(target.key);
        const category = target.tileHint?.subclass ?? target.tileHint?.class ?? null;
        const eager: HoverIdentity = cached ?? {
          place: {
            place_id: target.key,
            title: target.name,
            subtitle: "",
            address_lines: [],
            lat: target.lat,
            lon: target.lon,
            kind: category ?? undefined,
          },
          category,
        };
        resolvedTargetKey = target.key;
        setHoverLngLat([target.lon, target.lat]);
        setHover(eager);

        if (cached) { pendingTargetKey = null; return; }

        // Enrich in background with geocode (address, hours, phone, etc.).
        const currentRequest = ++requestId;
        void resolveHoverIdentity(
          { lat: target.lat, lon: target.lon, tileHint: target.tileHint },
          { signal: abortController.signal },
        )
          .then((identity) => {
            if (currentRequest !== requestId) return;
            pendingTargetKey = null;
            if (identity) {
              resolveCache.set(target.key, identity);
              resolvedTargetKey = target.key;
              setHover(identity);
            }
          })
          .catch((error: unknown) => {
            if (currentRequest !== requestId) return;
            if ((error as { name?: string }).name === "AbortError") return;
            pendingTargetKey = null;
          });
      }, 400);
    };

    const onLeave = () => {
      requestId += 1;
      abortController?.abort();
      abortController = null;
      resolvedTargetKey = null;
      pendingTargetKey = null;
      setHover(null);
      setHoverLngLat(null);
    };

    map.on("mousemove", onMove);
    map.getContainer().addEventListener("mouseleave", onLeave);
    return () => {
      map.off("mousemove", onMove);
      map.getContainer().removeEventListener("mouseleave", onLeave);
      if (hoverTimer !== null) window.clearTimeout(hoverTimer);
      abortController?.abort();
    };
  }, [mapRef, setHover, setHoverLngLat]);
}
