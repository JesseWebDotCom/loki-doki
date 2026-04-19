import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inCoverage,
  mergedCoverage,
  resolveTileSource,
  type BBox,
  type InstalledRegion,
} from "./tile-source";

const region = (
  id: string,
  bbox: BBox,
): InstalledRegion => ({
  region_id: id,
  label: id.toUpperCase(),
  bbox,
  center: { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 },
});

const CT: BBox = [-73.73, 40.95, -71.78, 42.05];
const RI: BBox = [-71.91, 41.15, -71.12, 42.02];
const UK: BBox = [-8.65, 49.90, 1.77, 60.85];

describe("mergedCoverage", () => {
  it("unions non-overlapping bboxes into a MultiPolygon", () => {
    const cov = mergedCoverage([region("us-ct", CT), region("uk", UK)]);
    expect(cov.type).toBe("MultiPolygon");
    expect(cov.coordinates).toHaveLength(2);
    // Each polygon ring has five points (closed rectangle).
    expect(cov.coordinates[0][0]).toHaveLength(5);
  });

  it("returns an empty MultiPolygon when no regions are installed", () => {
    const cov = mergedCoverage([]);
    expect(cov.coordinates).toEqual([]);
  });
});

describe("inCoverage", () => {
  const cov = mergedCoverage([region("us-ct", CT), region("uk", UK)]);

  it("returns true for a point inside Connecticut", () => {
    expect(inCoverage({ lng: -72.7, lat: 41.6 }, cov)).toBe(true);
  });

  it("returns true for a point inside the UK bbox", () => {
    expect(inCoverage({ lng: -0.12, lat: 51.5 }, cov)).toBe(true);
  });

  it("returns false for a point in the middle of the Atlantic", () => {
    expect(inCoverage({ lng: -30, lat: 40 }, cov)).toBe(false);
  });
});

// ── resolveTileSource ─────────────────────────────────────────────

describe("resolveTileSource", () => {
  const origOnline = Object.getOwnPropertyDescriptor(
    window.navigator,
    "onLine",
  );

  const setOnline = (value: boolean) => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => value,
    });
  };

  beforeEach(() => {
    setOnline(true);
  });

  afterEach(() => {
    if (origOnline) {
      Object.defineProperty(window.navigator, "onLine", origOnline);
    }
    vi.restoreAllMocks();
  });

  it("returns the first covering region when multiple overlap", async () => {
    // RI overlaps CT at the seam — first-match order must win.
    const ct = region("us-ct", CT);
    const ri = region("us-ri", RI);
    const result = await resolveTileSource(
      { lng: -71.85, lat: 41.8 },
      [ct, ri],
    );
    expect(result.kind).toBe("local");
    if (result.kind === "local") {
      expect(result.region).toBe("us-ct");
      expect(result.streetUrl).toBe(
        "pmtiles:///api/v1/maps/tiles/us-ct/streets.pmtiles",
      );
    }
  });

  it("falls back to the online Protomaps demo when outside coverage and online", async () => {
    const ct = region("us-ct", CT);
    const result = await resolveTileSource(
      { lng: -30, lat: 40 },  // middle of the Atlantic
      [ct],
    );
    expect(result.kind).toBe("online");
    if (result.kind === "online") {
      expect(result.streetUrl).toContain("protomaps.com");
    }
  });

  it("returns kind=none when offline and outside every region", async () => {
    setOnline(false);
    const ct = region("us-ct", CT);
    const result = await resolveTileSource(
      { lng: -30, lat: 40 },
      [ct],
    );
    expect(result.kind).toBe("none");
  });

  it("returns kind=none with zero regions and offline", async () => {
    setOnline(false);
    const result = await resolveTileSource(
      { lng: -72.7, lat: 41.6 },
      [],
    );
    expect(result.kind).toBe("none");
  });
});
