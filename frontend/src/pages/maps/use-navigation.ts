// Phase maps-skill chunk-06: active navigation state machine.
// Manages turn-by-turn following: locks camera, advances steps, recalculates.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import type { RouteAlt } from "./use-directions";
import { decodeGeometry } from "./route-layer";

export type NavState = "idle" | "navigating";

interface NavStep { text: string; distanceM: number; coords: [number, number]; }

function closestPointIndex(coords: [number, number][], lat: number, lon: number): number {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dlat = coords[i][1] - lat, dlon = coords[i][0] - lon;
    const d = dlat * dlat + dlon * dlon;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000, dLat = ((b[1] - a[1]) * Math.PI) / 180, dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function useNavigation(mapRef: MutableRefObject<maplibregl.Map | null>) {
  const [state, setState] = useState<NavState>("idle");
  const [stepIdx, setStepIdx] = useState(0);
  const [nextStep, setNextStep] = useState<NavStep | null>(null);
  const [remainingM, setRemainingM] = useState(0);
  const routeRef = useRef<RouteAlt | null>(null);
  const coordsRef = useRef<[number, number][]>([]);
  const watchRef = useRef<number | null>(null);

  function start(route: RouteAlt) {
    routeRef.current = route;
    coordsRef.current = decodeGeometry(route.geometry);
    setStepIdx(0);
    setState("navigating");
    setRemainingM(route.distance_m);
    if (route.maneuvers[0]) {
      const m = route.maneuvers[0];
      setNextStep({ text: m.text, distanceM: m.distance_m, coords: coordsRef.current[0] ?? [0, 0] });
    }
  }

  function stop() {
    setState("idle");
    setNextStep(null);
    setStepIdx(0);
    if (watchRef.current !== null) { navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; }
  }

  useEffect(() => {
    if (state !== "navigating") return;
    watchRef.current = navigator.geolocation.watchPosition((pos) => {
      const { latitude: lat, longitude: lon, heading } = pos.coords;
      const map = mapRef.current;
      if (map) {
        map.easeTo({ center: [lon, lat], bearing: heading ?? 0, pitch: 45, zoom: 17, duration: 1000, essential: true });
      }
      const coords = coordsRef.current;
      const route = routeRef.current;
      if (!coords.length || !route) return;
      const closestIdx = closestPointIndex(coords, lat, lon);
      const distToEnd = coords.slice(closestIdx).reduce((acc, c, i, arr) => i === 0 ? acc : acc + haversineM(arr[i - 1], c), 0);
      setRemainingM(distToEnd);
      const maneuvers = route.maneuvers;
      let cumulativeM = 0;
      for (let i = 0; i < maneuvers.length; i++) {
        cumulativeM += maneuvers[i].distance_m;
        if (cumulativeM > distToEnd) {
          if (i !== stepIdx) {
            setStepIdx(i);
            setNextStep({ text: maneuvers[i].text, distanceM: maneuvers[i].distance_m, coords: coords[closestIdx] });
          }
          break;
        }
      }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 1000 });
    return () => { if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current); };
  }, [state, mapRef, stepIdx]);

  return { state, nextStep, remainingM, start, stop };
}
