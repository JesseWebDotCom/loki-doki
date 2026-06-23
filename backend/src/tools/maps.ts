import type { Tool, ToolResult } from './index'
import { search, type GeocodeResult } from '@/lib/maps/geocoder'

// Companion tool: offline place search + directions over the installed map regions.
// Ported from v2 lokidoki/plugins/maps. Returns a deep link the frontend /maps page
// understands (?focus=lat,lon / ?to=lat,lon&mode=…) so "open in Maps" just works.
// Fully local — no external data source.

// POI categories the offline geocoder indexes (class column is `poi:<category>…`).
const CATEGORIES = [
  'restaurant', 'cafe', 'bar', 'grocery', 'hairdresser', 'barber', 'beauty', 'gym',
  'pharmacy', 'hospital', 'clinic', 'dentist', 'library', 'bank', 'post_office',
  'laundry', 'hotel', 'gas_station', 'atm', 'parking', 'museum', 'cinema', 'park',
  'optician',
] as const

interface PlaceOut {
  name: string
  address: string | null
  distance_m: number | null
  open_now: boolean | null
  lat: number
  lon: number
  phone: string | null
  website: string | null
  deep_link: string
}

function focusLink(r: { lat: number; lon: number; title: string }): string {
  return `/maps?focus=${r.lat.toFixed(5)},${r.lon.toFixed(5)}&q=${encodeURIComponent(r.title)}`
}

function toPlace(r: GeocodeResult): PlaceOut {
  return {
    name: r.title,
    address: r.subtitle || null,
    distance_m: r.distance_m,
    open_now: r.open_now,
    lat: r.lat,
    lon: r.lon,
    phone: r.phone,
    website: r.website,
    deep_link: focusLink(r),
  }
}

export const mapsTool: Tool = {
  id: 'maps',
  name: 'Maps',
  description:
    'Find a place, search for nearby businesses by category, or get directions using the offline map. Returns a link that opens the result in the Maps app.',
  offline: true,
  dataSources: [],
  examples: [
    'where is a place on the map',
    'show me a location on the map',
    'find restaurants / coffee / a pharmacy near me',
    'nearest gas station, atm, or grocery store',
    'directions to an address or place',
    'how do I get to a location, driving or walking',
    'route from one place to another',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'maps',
      description:
        'Offline maps: show a place, search nearby places by category, or get directions to a destination.',
      parameters: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: {
            type: 'string',
            enum: ['show_place', 'search', 'directions'],
            description:
              'show_place: locate a named place. search: find nearby places (optionally by category). directions: route to a destination.',
          },
          query: { type: 'string', description: 'Place name or free-text search (for show_place / search).' },
          category: {
            type: 'string',
            enum: CATEGORIES as unknown as string[],
            description: 'POI category when searching by type (e.g. restaurant, pharmacy, gas_station).',
          },
          to_query: { type: 'string', description: 'Destination address or place name (for directions).' },
          from_query: { type: 'string', description: 'Origin (for directions). Omit to use current location.' },
          mode: {
            type: 'string',
            enum: ['auto', 'pedestrian', 'bicycle'],
            description: 'Travel mode for directions. Default auto (driving).',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const {
      kind,
      query,
      category,
      to_query,
      from_query,
      mode = 'auto',
    } = args as {
      kind?: 'show_place' | 'search' | 'directions'
      query?: string
      category?: string
      to_query?: string
      from_query?: string
      mode?: 'auto' | 'pedestrian' | 'bicycle'
    }

    // Center comes from the user's saved location / client GPS (injected by the chat route).
    const lat = config?.['_lat'] as number | undefined
    const lng = config?.['_lng'] as number | undefined
    const center =
      typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat, lon: lng }
        : null

    const validMode = mode === 'pedestrian' || mode === 'bicycle' ? mode : 'auto'
    const cat = category && (CATEGORIES as readonly string[]).includes(category) ? category : null

    try {
      if (kind === 'directions') {
        const dest = to_query?.trim()
        if (!dest) return { success: false, error: 'A destination is required for directions' }
        const { results } = search({ query: dest, center, category: null, limit: 1 })
        const to = results[0]
        if (!to) {
          return { success: false, offline: true, error: `Couldn't find "${dest}" in the installed maps` }
        }

        let from: GeocodeResult | null = null
        if (from_query?.trim()) {
          from = search({ query: from_query.trim(), center, category: null, limit: 1 }).results[0] ?? null
        }

        const params = new URLSearchParams()
        params.set('to', `${to.lat.toFixed(5)},${to.lon.toFixed(5)}`)
        if (from) params.set('from', `${from.lat.toFixed(5)},${from.lon.toFixed(5)}`)
        else if (center) params.set('from', `${center.lat.toFixed(5)},${center.lon.toFixed(5)}`)
        if (validMode !== 'auto') params.set('mode', validMode)

        return {
          success: true,
          data: {
            kind: 'directions',
            to: { name: to.title, address: to.subtitle || null, lat: to.lat, lon: to.lon },
            from: from ? { name: from.title, address: from.subtitle || null } : from_query?.trim() ? null : 'current location',
            mode: validMode,
            deep_link: `/maps?${params.toString()}`,
          },
        }
      }

      // show_place / search
      const q = query?.trim()
      if (!q && !cat) {
        return { success: false, error: 'A place name or a category is required' }
      }

      const { results } = search({ query: q ?? cat ?? '', center, category: cat, limit: kind === 'show_place' ? 1 : 8 })
      if (results.length === 0) {
        return { success: false, offline: true, error: `Nothing found for "${q ?? cat}" in the installed maps` }
      }

      if (kind === 'show_place') {
        const top = results[0]!
        return {
          success: true,
          data: {
            kind: 'show_place',
            title: top.title,
            subtitle: top.subtitle || null,
            phone: top.phone,
            website: top.website,
            lat: top.lat,
            lon: top.lon,
            deep_link: focusLink(top),
          },
        }
      }

      return {
        success: true,
        data: {
          kind: 'search',
          query: q ?? null,
          category: cat,
          count: results.length,
          places: results.map(toPlace),
          deep_link: cat
            ? `/maps?category=${encodeURIComponent(cat)}${q ? `&q=${encodeURIComponent(q)}` : ''}`
            : `/maps?q=${encodeURIComponent(q ?? '')}`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
