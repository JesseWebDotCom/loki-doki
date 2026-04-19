import { describe, expect, it } from "vitest";
import {
  aggregateSize,
  changedRegions,
  estimateForPhase,
  flattenTree,
  formatMB,
  labelForPhase,
  type CatalogRegion,
  type SelectionMap,
} from "./MapsSection.helpers";

const region = (
  id: string,
  parent: string | null,
  street = 0,
  valhalla = 0,
  pbf = 0,
  children: CatalogRegion[] = [],
): CatalogRegion => ({
  region_id: id,
  label: id,
  parent_id: parent,
  center: { lat: 0, lon: 0 },
  bbox: [-1, -1, 1, 1],
  sizes_mb: { street, valhalla, pbf },
  downloadable: true,
  pi_local_build_ok: true,
  children,
});

describe("flattenTree", () => {
  it("produces a depth-first list with parents before children", () => {
    const ct = region("us-ct", "us");
    const ri = region("us-ri", "us");
    const us = region("us", "na", 0, 0, 0, [ct, ri]);
    const na = region("na", null, 0, 0, 0, [us]);

    const flat = flattenTree([na]);
    expect(flat.map((r) => r.region_id)).toEqual(["na", "us", "us-ct", "us-ri"]);
  });
});

describe("aggregateSize", () => {
  it("sums streets + valhalla for street-selected regions", () => {
    const ct = region("us-ct", "us", 80, 40);
    const ri = region("us-ri", "us", 30, 15);
    const selection: SelectionMap = {
      "us-ct": { street: true },
      "us-ri": { street: true },
    };
    const totals = aggregateSize([ct, ri], selection);
    expect(totals.street).toBe(80 + 40 + 30 + 15);
    expect(totals.total).toBe(totals.street);
  });

  it("handles nested selections via flattenTree", () => {
    const ct = region("us-ct", "us", 80, 40);
    const us = region("us", "na", 2000, 1000, 0, [ct]);
    const selection: SelectionMap = {
      "us-ct": { street: true },
    };
    const totals = aggregateSize(flattenTree([us]), selection);
    expect(totals.street).toBe(80 + 40);
  });

  it("returns zero when nothing is selected", () => {
    const ct = region("us-ct", "us", 80, 40);
    expect(aggregateSize([ct], {})).toEqual({ street: 0, total: 0 });
  });
});

describe("formatMB", () => {
  it("falls through to GB above 1024 MB", () => {
    expect(formatMB(2048)).toBe("2.0 GB");
    expect(formatMB(500)).toBe("500 MB");
    expect(formatMB(0)).toBe("0 MB");
  });
});

describe("changedRegions", () => {
  it("returns only regions whose street flag changed", () => {
    const before: SelectionMap = {
      "us-ct": { street: true },
      "us-ri": { street: false },
    };
    const after: SelectionMap = {
      "us-ct": { street: false },
      "us-ri": { street: false },
      "us-ca": { street: true },
    };
    expect(changedRegions(before, after).sort()).toEqual(["us-ca", "us-ct"]);
  });
});

describe("labelForPhase", () => {
  it("maps each known install phase to a human label", () => {
    expect(labelForPhase("downloading_pbf")).toBe("Downloading OSM data");
    expect(labelForPhase("building_geocoder")).toBe("Indexing addresses");
    expect(labelForPhase("building_streets")).toBe("Building vector tiles");
    expect(labelForPhase("building_routing")).toBe("Building road graph");
    expect(labelForPhase("complete")).toBe("Done");
  });

  it("falls through to the raw phase when unknown", () => {
    expect(labelForPhase("mystery")).toBe("mystery");
  });
});

describe("estimateForPhase", () => {
  it("returns a '~N min remaining' string for build_streets on Pi", () => {
    expect(estimateForPhase("building_streets", 25, "pi")).toBe("~5 min remaining");
  });

  it("scales down ~3× for mac", () => {
    // Pi gives ~35 min for a 175 MB pbf; mac should land near ~11 min.
    const pi = estimateForPhase("building_streets", 175, "pi");
    const mac = estimateForPhase("building_streets", 175, "mac");
    expect(pi).toBe("~35 min remaining");
    expect(mac).toBe("~11 min remaining");
  });

  it("returns empty string for phases without an estimate", () => {
    expect(estimateForPhase("downloading_pbf", 25, "pi")).toBe("");
    expect(estimateForPhase("complete", 25, "pi")).toBe("");
  });
});
