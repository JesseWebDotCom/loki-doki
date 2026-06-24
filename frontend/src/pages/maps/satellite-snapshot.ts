// A single, property-centered aerial image for a lat/lon, used as the hero photo
// for residential places that have no Wikipedia entry.
//
// We stitch Esri World_Imagery tiles (the same source as the SAT layer in
// style-satellite.ts) onto a canvas centered on the point, then export a data
// URL. The tile endpoint is fast (~150 ms, CDN-cached) and sends `ACAO: *`, so
// the canvas isn't tainted and toDataURL() works. We deliberately avoid the
// MapServer `export` endpoint — it's slow (3–5 s) and intermittently 500s, which
// looked like "worked on one POI then stopped".

const TILE = 256;
const ESRI_TILE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
// z19 is Esri World_Imagery's max with universal real coverage (z20 is placeholder
// tiles in rural areas). At 512 px that's ~115 m across — a single lot framed with
// a little surrounding context. z18 was too wide; the house looked tiny.
const ZOOM = 19;

// In-memory cache only — data URLs are too large to put in the localStorage photo
// cache (would blow the quota). Snapshots are cheap to regenerate per session.
const memo = new Map<string, string>();
const MAX_MEMO = 60;

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `${ESRI_TILE}/${z}/${y}/${x}`; // Esri order is {z}/{y}/{x}
  });
}

/** Memoized snapshot if one was already built this session, else null. */
export function peekSatelliteSnapshot(placeId: string): string | null {
  return memo.get(placeId) ?? null;
}

/**
 * Build (or return cached) a square aerial centered on the point, as a JPEG data
 * URL. Resolves null if no tiles loaded (e.g. offline) so callers can fall back
 * to the placeholder icon.
 */
export async function loadSatelliteSnapshot(
  placeId: string,
  lat: number,
  lon: number,
  { size = 512 }: { size?: number } = {},
): Promise<string | null> {
  const cached = memo.get(placeId);
  if (cached) return cached;

  const n = 2 ** ZOOM;
  const latRad = (lat * Math.PI) / 180;
  // Fractional tile coords → center in world pixels.
  const cx = ((lon + 180) / 360) * n * TILE;
  const cy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * TILE;
  const ox = cx - size / 2; // canvas top-left in world pixels
  const oy = cy - size / 2;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const minTX = Math.floor(ox / TILE);
  const maxTX = Math.floor((ox + size - 1) / TILE);
  const minTY = Math.floor(oy / TILE);
  const maxTY = Math.floor((oy + size - 1) / TILE);

  const draws: Promise<boolean>[] = [];
  for (let tx = minTX; tx <= maxTX; tx++) {
    for (let ty = minTY; ty <= maxTY; ty++) {
      if (ty < 0 || ty >= n) continue;
      const wrappedX = ((tx % n) + n) % n;
      draws.push(
        loadTile(ZOOM, wrappedX, ty).then((img) => {
          if (!img) return false;
          ctx.drawImage(img, tx * TILE - ox, ty * TILE - oy);
          return true;
        }),
      );
    }
  }

  const drawn = await Promise.all(draws);
  if (!drawn.some(Boolean)) return null; // nothing loaded — let caller show the icon

  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value as string);
  memo.set(placeId, dataUrl);
  return dataUrl;
}
