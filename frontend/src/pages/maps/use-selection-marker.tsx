/**
 * Selection marker + screen-projection hook for MapsPage.
 *
 * Owns the DOM marker that highlights the currently selected place
 * (the place chosen from search/recents), the camera flyTo, and the
 * screen-coordinate state that PoiHoverPreview needs to anchor the
 * details card next to the marker.
 *
 * Returns a synthesized HoverIdentity so the existing PoiHoverPreview
 * component renders the same card we use for true map hovers — the
 * selected place gets icon, badge, address, and distance for free.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import maplibregl from "maplibre-gl";

import { saveStoredMapView } from "./map-state";
import { poiBgColorFromIconId } from "./poi-colors";
import { poiCategoryIconId } from "./poi-icons";
import { poiLucideIcon } from "./poi-lucide-icons";
import { shouldRenderSelectionMarker } from "./selection-marker-policy";
import type { HoverIdentity } from "./hover";
import type { PlaceResult } from "./types";

export interface SelectionMarker {
  hoverIdentity: HoverIdentity | null;
  screenPoint: { x: number; y: number } | null;
}

export function useSelectionMarker(
  mapRef: React.MutableRefObject<maplibregl.Map | null>,
  selectedPlace: PlaceResult | null,
): SelectionMarker {
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const [screenPoint, setScreenPoint] = useState<{ x: number; y: number } | null>(null);
  const hoverIdentity = useMemo<HoverIdentity | null>(() => {
    if (!selectedPlace) return null;
    return { place: selectedPlace, category: selectedPlace.kind ?? null };
  }, [selectedPlace]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const place = selectedPlace;
    if (!place) {
      markerRef.current?.remove();
      markerRef.current = null;
      setScreenPoint(null);
      return;
    }
    saveStoredMapView({
      center: { lat: place.lat, lon: place.lon },
      zoom: map.getZoom(),
      selectedPlace: place,
    });
    const lngLat: [number, number] = [place.lon, place.lat];
    const p = map.project(lngLat);
    setScreenPoint({ x: p.x, y: p.y });
    let removeListeners = (): void => {};
    if (!shouldRenderSelectionMarker(place)) {
      markerRef.current?.remove();
      markerRef.current = null;
      return () => {
        removeListeners();
      };
    }
    const iconId = poiCategoryIconId(place.kind ?? null);
    const Icon = poiLucideIcon(iconId);
    const tint = poiBgColorFromIconId(iconId);
    const iconSvg = renderToStaticMarkup(
      <Icon size={18} color="#ffffff" strokeWidth={2.4} />,
    );
    const brandSrc = place.brand_qid ? `/api/maps/logos/${place.brand_qid}.png` : null;
    const faviconSrc = (() => {
      if (!place.website) return null;
      try {
        const u = new URL(place.website.startsWith("http") ? place.website : `https://${place.website}`);
        return `${u.origin}/favicon.ico`;
      } catch { return null; }
    })();
    const logoSrc = brandSrc ?? faviconSrc;
    const attachMarker = (): void => {
      markerRef.current?.remove();
      const el = document.createElement("div");
      el.setAttribute("aria-label", "Selected place");
      el.style.width = "36px";
      el.style.height = "36px";
      el.style.borderRadius = "9999px";
      el.style.background = tint;
      el.style.border = "3px solid #ffffff";
      el.style.boxShadow = `0 8px 24px rgba(0,0,0,0.45), 0 0 0 4px ${tint}33`;
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.cursor = "pointer";
      el.style.overflow = "hidden";
      el.innerHTML = iconSvg;
      // Overlay brand logo — load async, swap in on success.
      if (logoSrc) {
        const img = new Image();
        let triedFavicon = false;
        img.onload = () => {
          el.innerHTML = "";
          el.style.background = "#ffffff";
          el.style.border = "3px solid rgba(0,0,0,0.12)";
          el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
          el.style.padding = "5px";
          const imgEl = document.createElement("img");
          imgEl.src = img.src;
          imgEl.style.cssText = "width:100%;height:100%;object-fit:contain;border-radius:3px;";
          el.appendChild(imgEl);
        };
        img.onerror = () => {
          if (!triedFavicon && brandSrc && faviconSrc) {
            triedFavicon = true;
            img.src = faviconSrc;
          }
        };
        img.src = logoSrc;
      }
      markerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat(lngLat)
        .addTo(map);
    };
    if (map.isStyleLoaded()) {
      attachMarker();
    } else {
      map.once("load", attachMarker);
    }
    return () => {
      removeListeners();
      // Cancel a pending attach: without this, clearing the place (e.g. hiding
      // the pin on the globe) before the style loads still fires the stale
      // handler and re-adds the marker.
      map.off("load", attachMarker);
    };
  }, [selectedPlace, mapRef]);

  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  return { hoverIdentity, screenPoint };
}
