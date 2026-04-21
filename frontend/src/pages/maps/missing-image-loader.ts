import type { Map as MapLibreMap } from 'maplibre-gl';

type StyleImageMissingEvent = { id?: string } & Record<string, unknown>;

/**
 * Install a fallback image loader for icon ids missing from the current style.
 *
 * `setStyle()` clears runtime-added images, so the guard only tracks in-flight
 * requests. Once an image finishes loading, future style swaps may request it
 * again and should be allowed to re-register it on the new style.
 */
export function installMissingImageLoader(
  map: MapLibreMap,
  imagePathForId: (id: string) => string = (id) => `/sprites/source/${id}.svg`,
): () => void {
  const inFlight = new Set<string>();

  const handleMissingImage = (event: StyleImageMissingEvent) => {
    const id = event.id;
    if (!id || inFlight.has(id) || map.hasImage(id)) return;

    inFlight.add(id);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      inFlight.delete(id);
      if (!map.getStyle() || map.hasImage(id)) return;
      try {
        map.addImage(id, img, { sdf: !id.startsWith('shield_') });
      } catch {
        // The style may have swapped again while the image was loading.
      }
    };
    img.onerror = () => {
      inFlight.delete(id);
    };
    img.src = imagePathForId(id);
  };

  map.on('styleimagemissing', handleMissingImage);
  return () => {
    map.off('styleimagemissing', handleMissingImage);
  };
}
