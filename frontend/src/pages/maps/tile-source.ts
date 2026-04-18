/**
 * Resolve the tile source MapLibre should render from.
 *
 * Chunk 1 stub: always returns the online Protomaps demo. Chunk 2
 * populates `/api/v1/maps/regions` with installed regions and this
 * helper starts preferring a local `pmtiles://…` URL whenever one
 * covers the current viewport.
 */

export type TileSource =
  | { kind: 'online'; url: string }
  | { kind: 'local'; url: string; region: string };

const ONLINE_DEMO_URL =
  'pmtiles://https://demo-bucket.protomaps.com/v4.pmtiles';

export async function resolveTileSource(): Promise<TileSource> {
  // Fire-and-forget call so future chunks can start observing request
  // shape in the network tab. The empty body is ignored here.
  try {
    const res = await fetch('/api/v1/maps/regions');
    if (res.ok) {
      // Future chunks will read the body and pick a local region.
      await res.json().catch(() => []);
    }
  } catch {
    // Offline or backend not up yet — demo URL is still the right fallback.
  }
  return { kind: 'online', url: ONLINE_DEMO_URL };
}
