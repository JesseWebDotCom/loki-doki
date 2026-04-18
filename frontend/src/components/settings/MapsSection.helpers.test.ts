import { describe, expect, it } from "vitest";
import {
  aggregateSize,
  changedRegions,
  flattenTree,
  formatMB,
  validateSelection,
  type CatalogRegion,
  type SelectionMap,
} from "./MapsSection.helpers";

const region = (
  id: string,
  parent: string | null,
  street = 0,
  satellite = 0,
  valhalla = 0,
  children: CatalogRegion[] = [],
): CatalogRegion => ({
  region_id: id,
  label: id,
  parent_id: parent,
  center: { lat: 0, lon: 0 },
  bbox: [-1, -1, 1, 1],
  sizes_mb: { street, satellite, valhalla, pbf: 0 },
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
    const ct = region("us-ct", "us", 80, 1600, 40);
    const ri = region("us-ri", "us", 30, 600, 15);
    const selection: SelectionMap = {
      "us-ct": { street: true, satellite: false },
      "us-ri": { street: true, satellite: true },
    };
    const totals = aggregateSize([ct, ri], selection);
    expect(totals.street).toBe(80 + 40 + 30 + 15);
    expect(totals.satellite).toBe(600);
    expect(totals.total).toBe(totals.street + totals.satellite);
  });

  it("handles nested selections via flattenTree", () => {
    const ct = region("us-ct", "us", 80, 1600, 40);
    const us = region("us", "na", 2000, 40000, 1000, [ct]);
    const selection: SelectionMap = {
      "us-ct": { street: true, satellite: false },
    };
    const totals = aggregateSize(flattenTree([us]), selection);
    expect(totals.street).toBe(80 + 40);
    expect(totals.satellite).toBe(0);
  });

  it("returns zero when nothing is selected", () => {
    const ct = region("us-ct", "us", 80, 1600, 40);
    expect(aggregateSize([ct], {})).toEqual({ street: 0, satellite: 0, total: 0 });
  });
});

describe("validateSelection", () => {
  it("rejects satellite-only selections", () => {
    const selection: SelectionMap = {
      "us-ct": { street: false, satellite: true },
    };
    expect(validateSelection(selection)).toBe("us-ct");
  });

  it("accepts satellite when street is also selected", () => {
    const selection: SelectionMap = {
      "us-ct": { street: true, satellite: true },
    };
    expect(validateSelection(selection)).toBeNull();
  });

  it("ignores fully-unselected rows", () => {
    const selection: SelectionMap = {
      "us-ct": { street: false, satellite: false },
    };
    expect(validateSelection(selection)).toBeNull();
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
  it("returns only regions whose flags changed", () => {
    const before: SelectionMap = {
      "us-ct": { street: true, satellite: false },
      "us-ri": { street: false, satellite: false },
    };
    const after: SelectionMap = {
      "us-ct": { street: true, satellite: true },
      "us-ri": { street: false, satellite: false },
      "us-ca": { street: true, satellite: false },
    };
    expect(changedRegions(before, after).sort()).toEqual(["us-ca", "us-ct"]);
  });
});
