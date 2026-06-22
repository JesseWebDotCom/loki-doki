import type { Map as MapLibreMap } from "maplibre-gl";

type StyleImageMissingEvent = { id?: string } & Record<string, unknown>;
type StyleDataEvent = Record<string, unknown>;

const KNOWN_MAP_IMAGE_IDS = [
  "shield_interstate",
  "shield_us",
  "shield_state",
  "label_pill",
];

const PILL_ADD_OPTIONS = {
  pixelRatio: 2,
  stretchX: [[18, 46]] as [number, number][],
  stretchY: [[10, 22]] as [number, number][],
  content: [10, 6, 54, 26] as [number, number, number, number],
};

function svgDataUri(id: string): string | null {
  if (id === "shield_interstate") {
    return encodeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="44" viewBox="0 0 64 44"><rect x="4" y="4" width="56" height="36" rx="10" fill="#2563eb" stroke="#ffffff" stroke-width="4"/></svg>`,
    );
  }
  if (id === "shield_us") {
    return encodeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="44" viewBox="0 0 64 44"><rect x="4" y="4" width="56" height="36" rx="10" fill="#f8fafc" stroke="#1f2937" stroke-width="4"/></svg>`,
    );
  }
  if (id === "shield_state") {
    return encodeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="44" viewBox="0 0 64 44"><rect x="4" y="4" width="56" height="36" rx="10" fill="#fbbf24" stroke="#7c2d12" stroke-width="4"/></svg>`,
    );
  }
  if (id === "label_pill") {
    const pillFill = "#ffffff";
    return encodeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">
        <defs>
          <filter id="s" x="-20%" y="-20%" width="140%" height="160%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.4"/>
            <feOffset dx="0" dy="1.2"/>
            <feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>
            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <rect x="3" y="3" width="58" height="22" rx="11" fill="${pillFill}" filter="url(#s)"/>
      </svg>`,
    );
  }
  return null;
}

function encodeSvg(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function installMissingImageLoader(map: MapLibreMap): () => void {
  const inFlight = new Set<string>();

  const ensureImage = (id: string) => {
    if (!id || inFlight.has(id) || map.hasImage(id)) return;
    const src = svgDataUri(id);
    if (!src) return;
    inFlight.add(id);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      inFlight.delete(id);
      if (!map.getStyle() || map.hasImage(id)) return;
      try {
        if (id === "label_pill") {
          map.addImage(id, img, PILL_ADD_OPTIONS);
        } else {
          map.addImage(id, img);
        }
      } catch {
        // Style may have swapped before image finished loading.
      }
    };
    img.onerror = () => {
      inFlight.delete(id);
    };
    img.src = src;
  };

  const handleMissingImage = (event: StyleImageMissingEvent) => {
    const id = event.id;
    if (!id) return;
    if (svgDataUri(id)) {
      ensureImage(id);
    } else if (!map.hasImage(id)) {
      // Unknown POI sprite image — add a 1×1 transparent placeholder so
      // MapLibre stops emitting the warning. The icon simply won't render.
      try {
        map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
      } catch { /* ignore */ }
    }
  };

  const handleStyleData = (_event: StyleDataEvent) => {
    if (!map.getStyle()) return;
    for (const id of KNOWN_MAP_IMAGE_IDS) {
      ensureImage(id);
    }
  };

  map.on("styleimagemissing", handleMissingImage);
  map.on("styledata", handleStyleData);
  handleStyleData({});
  return () => {
    map.off("styleimagemissing", handleMissingImage);
    map.off("styledata", handleStyleData);
  };
}
