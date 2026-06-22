import { useEffect } from "react";
import type maplibregl from "maplibre-gl";

// Slow auto-rotation for the globe view. The earth spins on its own while
// zoomed out; any manual gesture pauses it, and it resumes after a quiet
// period. Only active at low zoom (the globe is gone once you've dived in).
const GLOBE_ZOOM_MAX = 3.5; // only spin when pulled back to the globe
const DEG_PER_FRAME = 0.018; // ~1 deg/sec at 60fps — a slow, calm drift
const RESUME_AFTER_MS = 4000; // wait this long after a manual gesture before resuming

/**
 * Drives the globe's idle auto-rotation.
 *
 * `spinningRef` is shared with MapsPage's `moveend` handler: while we drive the
 * camera each frame we set it true so the handler skips its per-move work
 * (tile-source recompute + localStorage write), which would otherwise run 60×/sec.
 * A user gesture (any move with an `originalEvent`) pauses rotation and lets the
 * handler save normally.
 */
export function useGlobeSpin(
  mapRef: React.MutableRefObject<maplibregl.Map | null>,
  spinningRef: React.MutableRefObject<boolean>,
): void {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let raf = 0;
    let disposed = false;
    let lastInteraction = 0;

    const onUserGesture = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) lastInteraction = Date.now();
    };
    map.on("movestart", onUserGesture);
    map.on("zoomstart", onUserGesture);
    map.on("rotatestart", onUserGesture);
    map.on("dragstart", onUserGesture);

    const frame = () => {
      if (disposed) return;
      const idle = Date.now() - lastInteraction > RESUME_AFTER_MS;
      const willRotate = idle && map.getZoom() <= GLOBE_ZOOM_MAX && !map.isMoving();
      spinningRef.current = willRotate;
      if (willRotate) {
        const c = map.getCenter();
        map.setCenter([c.lng + DEG_PER_FRAME, c.lat]);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      spinningRef.current = false;
      map.off("movestart", onUserGesture);
      map.off("zoomstart", onUserGesture);
      map.off("rotatestart", onUserGesture);
      map.off("dragstart", onUserGesture);
    };
  }, [mapRef, spinningRef]);
}
