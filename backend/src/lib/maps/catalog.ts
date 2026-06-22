// Offline map region catalog — ported from v2 lokidoki/maps/seed.py.
//
// Regions form a continent → country/state tree. Only leaf regions are
// `downloadable`; continents are containers. PBF data comes from Geofabrik.

export interface MapRegion {
  regionId: string
  label: string
  parentId: string | null
  center: { lat: number; lon: number }
  bbox: [number, number, number, number]   // [minLon, minLat, maxLon, maxLat]
  sizesMb: { street: number; valhalla: number; pbf: number }
  downloadable: boolean
  pbfUrl: string
}

const GEOFABRIK = 'https://download.geofabrik.de'

// [id, label, center(lat,lon), bbox(minLon,minLat,maxLon,maxLat)]
const CONTINENTS: [string, string, [number, number], [number, number, number, number]][] = [
  ['na', 'North America', [45.0, -100.0], [-170.0, 10.0, -50.0, 75.0]],
  ['eu', 'Europe', [54.0, 15.0], [-25.0, 35.0, 40.0, 72.0]],
  ['as', 'Asia', [35.0, 100.0], [25.0, 0.0, 180.0, 75.0]],
]

// [id, label, parent, center(lat,lon), bbox, geofabrikPath, streetMb, pbfMb]
const COUNTRIES: [string, string, string, [number, number], [number, number, number, number], string, number, number][] = [
  ['us', 'United States (contiguous)', 'na', [39.5, -98.35], [-125.0, 24.5, -66.9, 49.4], 'north-america/us', 2048, 10240],
  ['ca', 'Canada', 'na', [56.1, -106.3], [-141.0, 41.7, -52.6, 83.1], 'north-america/canada', 1500, 5500],
  ['mx', 'Mexico', 'na', [23.6, -102.5], [-118.6, 14.5, -86.7, 32.8], 'north-america/mexico', 600, 1900],
  ['uk', 'United Kingdom', 'eu', [54.0, -2.4], [-8.2, 49.9, 1.8, 60.9], 'europe/great-britain', 500, 1200],
  ['de', 'Germany', 'eu', [51.1, 10.4], [5.9, 47.3, 15.0, 55.1], 'europe/germany', 700, 3500],
  ['fr', 'France', 'eu', [46.6, 2.2], [-4.8, 41.3, 9.6, 51.1], 'europe/france', 650, 3100],
  ['it', 'Italy', 'eu', [41.9, 12.6], [6.6, 35.5, 18.5, 47.1], 'europe/italy', 450, 1800],
  ['jp', 'Japan', 'as', [36.2, 138.3], [122.9, 24.4, 145.8, 45.6], 'asia/japan', 600, 2200],
]

// [code, label, geofabrikSlug, lat, lon, areaMi2]
const US_STATES: [string, string, string, number, number, number][] = [
  ['al', 'Alabama', 'alabama', 32.80, -86.80, 52420], ['ak', 'Alaska', 'alaska', 64.20, -152.00, 665384],
  ['az', 'Arizona', 'arizona', 34.30, -111.70, 113990], ['ar', 'Arkansas', 'arkansas', 34.90, -92.40, 53179],
  ['ca', 'California', 'california', 37.20, -119.50, 163695], ['co', 'Colorado', 'colorado', 39.00, -105.50, 104094],
  ['ct', 'Connecticut', 'connecticut', 41.60, -72.70, 5543], ['de', 'Delaware', 'delaware', 39.00, -75.50, 2489],
  ['fl', 'Florida', 'florida', 28.60, -81.80, 65758], ['ga', 'Georgia', 'georgia', 32.90, -83.40, 59425],
  ['hi', 'Hawaii', 'hawaii', 20.20, -156.50, 10932], ['id', 'Idaho', 'idaho', 44.20, -114.60, 83569],
  ['il', 'Illinois', 'illinois', 40.00, -89.20, 57914], ['in', 'Indiana', 'indiana', 39.90, -86.30, 36420],
  ['ia', 'Iowa', 'iowa', 42.00, -93.20, 56273], ['ks', 'Kansas', 'kansas', 38.50, -98.40, 82278],
  ['ky', 'Kentucky', 'kentucky', 37.50, -84.90, 40408], ['la', 'Louisiana', 'louisiana', 31.10, -91.80, 52378],
  ['me', 'Maine', 'maine', 45.30, -69.20, 35380], ['md', 'Maryland', 'maryland', 39.00, -76.80, 12406],
  ['ma', 'Massachusetts', 'massachusetts', 42.20, -71.80, 10554], ['mi', 'Michigan', 'michigan', 43.90, -84.50, 96714],
  ['mn', 'Minnesota', 'minnesota', 46.30, -94.30, 86936], ['ms', 'Mississippi', 'mississippi', 32.70, -89.70, 48432],
  ['mo', 'Missouri', 'missouri', 38.50, -92.30, 69707], ['mt', 'Montana', 'montana', 47.00, -109.60, 147040],
  ['ne', 'Nebraska', 'nebraska', 41.50, -99.80, 77348], ['nv', 'Nevada', 'nevada', 39.30, -116.70, 110572],
  ['nh', 'New Hampshire', 'new-hampshire', 43.70, -71.60, 9349], ['nj', 'New Jersey', 'new-jersey', 40.20, -74.70, 8723],
  ['nm', 'New Mexico', 'new-mexico', 34.50, -106.10, 121590], ['ny', 'New York', 'new-york', 42.90, -75.50, 54555],
  ['nc', 'North Carolina', 'north-carolina', 35.60, -79.40, 53819], ['nd', 'North Dakota', 'north-dakota', 47.50, -100.50, 70698],
  ['oh', 'Ohio', 'ohio', 40.40, -82.80, 44826], ['ok', 'Oklahoma', 'oklahoma', 35.50, -97.50, 69899],
  ['or', 'Oregon', 'oregon', 44.10, -120.50, 98379], ['pa', 'Pennsylvania', 'pennsylvania', 40.90, -77.80, 46054],
  ['ri', 'Rhode Island', 'rhode-island', 41.70, -71.50, 1545], ['sc', 'South Carolina', 'south-carolina', 33.90, -80.90, 32020],
  ['sd', 'South Dakota', 'south-dakota', 44.40, -100.20, 77116], ['tn', 'Tennessee', 'tennessee', 35.80, -86.30, 42144],
  ['tx', 'Texas', 'texas', 31.10, -99.30, 268596], ['ut', 'Utah', 'utah', 39.30, -111.70, 84897],
  ['vt', 'Vermont', 'vermont', 44.00, -72.70, 9616], ['va', 'Virginia', 'virginia', 37.80, -78.20, 42775],
  ['wa', 'Washington', 'washington', 47.40, -120.40, 71362], ['wv', 'West Virginia', 'west-virginia', 38.50, -80.70, 24230],
  ['wi', 'Wisconsin', 'wisconsin', 44.30, -89.60, 65498], ['wy', 'Wyoming', 'wyoming', 42.80, -107.30, 97813],
]

const round = (n: number, d: number) => {
  const f = 10 ** d
  return Math.round(n * f) / f
}

function buildCatalog(): MapRegion[] {
  const regions: MapRegion[] = []
  for (const [id, label, [lat, lon], bbox] of CONTINENTS) {
    regions.push({
      regionId: id, label, parentId: null,
      center: { lat, lon }, bbox,
      sizesMb: { street: 0, valhalla: 0, pbf: 0 },
      downloadable: false, pbfUrl: '',
    })
  }
  for (const [id, label, parentId, [lat, lon], bbox, geofabrikPath, streetMb, pbfMb] of COUNTRIES) {
    regions.push({
      regionId: id, label, parentId,
      center: { lat, lon }, bbox,
      sizesMb: { street: streetMb, valhalla: Math.round(streetMb * 0.5), pbf: pbfMb },
      downloadable: true,
      pbfUrl: `${GEOFABRIK}/${geofabrikPath}-latest.osm.pbf`,
    })
  }
  for (const [code, label, slug, lat, lon, areaMi2] of US_STATES) {
    const streetMb = Math.max(20, Math.round(Math.sqrt(areaMi2) * 1.2))
    const latSpan = Math.max(Math.sqrt(areaMi2), 30.0) / 69.0
    const lonSpan = latSpan / Math.max(Math.cos((lat * Math.PI) / 180), 0.25)
    regions.push({
      regionId: `us-${code}`, label, parentId: 'us',
      center: { lat, lon },
      bbox: [round(lon - lonSpan, 3), round(lat - latSpan, 3), round(lon + lonSpan, 3), round(lat + latSpan, 3)],
      sizesMb: { street: streetMb, valhalla: Math.max(10, Math.round(streetMb * 0.5)), pbf: Math.max(10, Math.round(streetMb * 2.5)) },
      downloadable: true,
      pbfUrl: `${GEOFABRIK}/north-america/us/${slug}-latest.osm.pbf`,
    })
  }
  return regions
}

export const MAP_CATALOG: Map<string, MapRegion> = new Map(
  buildCatalog().map((r) => [r.regionId, r]),
)

export function getRegion(regionId: string): MapRegion | undefined {
  return MAP_CATALOG.get(regionId)
}

export function listCatalog(): MapRegion[] {
  return [...MAP_CATALOG.values()]
}

// Nested tree (continents → children) for the admin browser.
export interface CatalogNode extends MapRegion {
  children: CatalogNode[]
}

export function catalogTree(): CatalogNode[] {
  const byParent = new Map<string | null, MapRegion[]>()
  for (const r of MAP_CATALOG.values()) {
    const arr = byParent.get(r.parentId) ?? []
    arr.push(r)
    byParent.set(r.parentId, arr)
  }
  const build = (parentId: string | null): CatalogNode[] =>
    (byParent.get(parentId) ?? []).map((r) => ({ ...r, children: build(r.regionId) }))
  return build(null)
}
