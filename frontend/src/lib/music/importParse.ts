// Parsers for the Music playlist-import surface. Three shapes, all resolved to the
// same {title, artist, durationSec} entries the /api/music/import/resolve route takes:
//   1. Exportify-style CSV (the common Spotify export), matched by column NAME so
//      column order and extra columns do not matter
//   2. A JSON array of objects (loose key matching: title/track/name, artist/artists)
//   3. Plain lines: "Artist - Title" (or "Title - Artist" is NOT guessed; see below)

import type { ImportEntry } from '@/lib/music/portabilityApi'

export type ImportFormat = 'csv' | 'json' | 'lines'
export interface ParseResult { entries: ImportEntry[]; format: ImportFormat; skipped: number }

// ── CSV ─────────────────────────────────────────────────────────────────────────────

/** RFC-4180 CSV row splitter: handles quoted fields, embedded commas, and "" escapes. */
function splitCsvRow(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ }   // escaped quote
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out.map(f => f.trim())
}

/** Split a CSV document into rows, honoring newlines inside quoted fields. */
function splitCsvRows(text: string): string[] {
  const rows: string[] = []
  let row = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') { inQuotes = !inQuotes; row += ch; continue }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (row.trim()) rows.push(row)
      row = ''
      continue
    }
    row += ch
  }
  if (row.trim()) rows.push(row)
  return rows
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

// Exportify's headers, plus the aliases other exporters use. Matched by name so a
// reordered or extended export still lands.
const TITLE_KEYS = ['trackname', 'track', 'title', 'name', 'song', 'songname']
const ARTIST_KEYS = ['artistnames', 'artistname', 'artist', 'artists', 'albumartistnames']
const DURATION_MS_KEYS = ['trackdurationms', 'durationms', 'lengthms']
const DURATION_SEC_KEYS = ['trackdurationsec', 'durationsec', 'duration', 'length', 'time']

function findIndex(headers: string[], keys: string[]): number {
  for (const key of keys) {
    const i = headers.indexOf(key)
    if (i >= 0) return i
  }
  return -1
}

/** "3:45" or "225" (seconds) -> seconds. */
function parseDurationText(raw: string): number | null {
  const v = raw.trim()
  if (!v) return null
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Math.round(Number(v))
    return n > 0 ? n : null
  }
  const parts = v.split(':').map(p => Number.parseInt(p, 10))
  if (parts.some(p => Number.isNaN(p) || p < 0)) return null
  let sec = 0
  for (const p of parts) sec = sec * 60 + p
  return sec > 0 ? sec : null
}

/** Exports list multiple artists as "A, B" or "A; B" - the first is the credited one
 *  our resolver matches best. */
const primaryArtist = (raw: string) => raw.split(/[,;]|\sfeat\.?\s|\s&\s/i)[0]!.trim()

function parseCsv(text: string): ParseResult {
  const rows = splitCsvRows(text)
  if (!rows.length) return { entries: [], format: 'csv', skipped: 0 }

  const headers = splitCsvRow(rows[0]!).map(norm)
  const ti = findIndex(headers, TITLE_KEYS)
  const ai = findIndex(headers, ARTIST_KEYS)
  const dmsI = findIndex(headers, DURATION_MS_KEYS)
  const dsecI = findIndex(headers, DURATION_SEC_KEYS)
  if (ti < 0) return { entries: [], format: 'csv', skipped: 0 }

  const entries: ImportEntry[] = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    const cells = splitCsvRow(row)
    const title = cells[ti]?.trim() ?? ''
    if (!title) { skipped++; continue }
    let durationSec: number | null = null
    if (dmsI >= 0) {
      const ms = Number(cells[dmsI])
      if (Number.isFinite(ms) && ms > 0) durationSec = Math.round(ms / 1000)
    }
    if (durationSec == null && dsecI >= 0) durationSec = parseDurationText(cells[dsecI] ?? '')
    entries.push({ title, artist: ai >= 0 ? primaryArtist(cells[ai] ?? '') : '', durationSec })
  }
  return { entries, format: 'csv', skipped }
}

// ── JSON ────────────────────────────────────────────────────────────────────────────

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(norm(k))) continue
    if (typeof v === 'string' && v.trim()) return v.trim()
    // Some exports nest {artist: {name}} or {artists: [{name}]}.
    if (Array.isArray(v) && v.length) {
      const first = v[0]
      if (typeof first === 'string') return first.trim()
      if (first && typeof first === 'object' && typeof (first as { name?: unknown }).name === 'string') {
        return (first as { name: string }).name.trim()
      }
    }
    if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
      return (v as { name: string }).name.trim()
    }
  }
  return ''
}

function parseJson(text: string): ParseResult | null {
  let data: unknown
  try { data = JSON.parse(text) } catch { return null }
  // Accept a bare array, or a wrapper like {tracks: [...]} / {items: [...]}.
  const list = Array.isArray(data)
    ? data
    : (data && typeof data === 'object'
        ? (Object.values(data as Record<string, unknown>).find(v => Array.isArray(v)) as unknown[] | undefined)
        : undefined)
  if (!Array.isArray(list)) return null

  const entries: ImportEntry[] = []
  let skipped = 0
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { skipped++; continue }
    const obj = raw as Record<string, unknown>
    // Spotify's own export nests the real fields under `track`.
    const src = (obj.track && typeof obj.track === 'object' && !Array.isArray(obj.track))
      ? obj.track as Record<string, unknown>
      : obj
    const title = pick(src, TITLE_KEYS)
    if (!title) { skipped++; continue }
    const artist = primaryArtist(pick(src, ARTIST_KEYS))
    const msRaw = Object.entries(src).find(([k]) => DURATION_MS_KEYS.includes(norm(k)))?.[1]
    const secRaw = Object.entries(src).find(([k]) => DURATION_SEC_KEYS.includes(norm(k)))?.[1]
    let durationSec: number | null = null
    if (typeof msRaw === 'number' && msRaw > 0) durationSec = Math.round(msRaw / 1000)
    else if (typeof secRaw === 'number' && secRaw > 0) durationSec = Math.round(secRaw)
    else if (typeof secRaw === 'string') durationSec = parseDurationText(secRaw)
    entries.push({ title, artist, durationSec })
  }
  return { entries, format: 'json', skipped }
}

// ── Plain lines ─────────────────────────────────────────────────────────────────────

/** "Artist - Title" per line. The dash convention is Artist first (Last.fm, Web
 *  Scrobbler, every "now playing" string), so we do not try to guess the other way:
 *  a wrong guess silently mis-imports, and the review step can fix a swap. Lines with
 *  no separator become a title-only entry, which still resolves surprisingly well. */
function parseLines(text: string): ParseResult {
  const entries: ImportEntry[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^\d+[.)]\s+/, '')   // drop "1. " / "1) " list numbering
    if (!line) continue
    // design-ok(em-dash): matching a separator real exports use, not authoring copy.
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(line)
    if (m) entries.push({ title: m[2]!.trim(), artist: m[1]!.trim(), durationSec: null })
    else if (line.length > 1) entries.push({ title: line, artist: '', durationSec: null })
    else skipped++
  }
  return { entries, format: 'lines', skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────────────

/** Sniff the format and parse. `filename` only nudges the CSV/JSON decision; the
 *  content itself is what actually decides, so a pasted CSV works with no file. */
export function parseTrackList(text: string, filename?: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { entries: [], format: 'lines', skipped: 0 }

  if (trimmed.startsWith('[') || trimmed.startsWith('{') || filename?.toLowerCase().endsWith('.json')) {
    const json = parseJson(trimmed)
    if (json && json.entries.length) return json
  }

  // A header row naming a title column is the real CSV tell (a comma alone is not:
  // "Artist - Title, Live" is a plain line).
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? ''
  const headers = splitCsvRow(firstLine).map(norm)
  const looksCsv = headers.length > 1 && findIndex(headers, TITLE_KEYS) >= 0
  if (looksCsv || filename?.toLowerCase().endsWith('.csv')) {
    const csv = parseCsv(trimmed)
    if (csv.entries.length) return csv
  }

  return parseLines(trimmed)
}
