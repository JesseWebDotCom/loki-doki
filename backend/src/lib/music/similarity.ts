// Sound-similarity engine over the music_track_features embeddings (discogs-effnet,
// 1280-d). Brute-force cosine against an in-memory cache — at household scale (a few
// thousand analyzed tracks ≈ 25 MB) this is single-digit milliseconds; no ANN index
// needed. The cache lazy-loads on first query and invalidates when a new analysis lands.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicTrackFeatures } from '@/db/schema'
import { INTEL_MODEL_VERSION } from '@/lib/stems/pyenv'
import { logger } from '@/lib/logger'

export interface FeatureRow {
  ref: string
  title: string | null
  artist: string | null
  tags: string[]
  energy: number | null
  valence: number | null
  danceability: number | null
  acousticness: number | null
  bpm: number | null
  /** L2-normalised at load, so cosine similarity = dot product. */
  embedding: Float32Array
}

let cache: FeatureRow[] | null = null
let loading: Promise<FeatureRow[]> | null = null

export function invalidateSimilarityCache(): void { cache = null; loading = null }

async function load(): Promise<FeatureRow[]> {
  if (cache) return cache
  if (loading) return loading
  loading = (async () => {
    const rows = await db.select().from(musicTrackFeatures).where(eq(musicTrackFeatures.status, 'ready'))
    const out: FeatureRow[] = []
    for (const r of rows) {
      if (r.modelVersion !== INTEL_MODEL_VERSION || !r.embedding) continue
      const raw = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
      let norm = 0
      for (let i = 0; i < raw.length; i++) norm += raw[i]! * raw[i]!
      norm = Math.sqrt(norm)
      if (!norm || !Number.isFinite(norm)) continue
      const emb = new Float32Array(raw.length)
      for (let i = 0; i < raw.length; i++) emb[i] = raw[i]! / norm
      out.push({
        ref: r.ref, title: r.title, artist: r.artist,
        tags: r.tagsJson ? (JSON.parse(r.tagsJson) as string[]) : [],
        energy: r.energy, valence: r.valence, danceability: r.danceability,
        acousticness: r.acousticness, bpm: r.bpm, embedding: emb,
      })
    }
    cache = out
    loading = null
    logger.info(`[music-intel] similarity cache loaded: ${out.length} tracks`)
    return out
  })()
  return loading
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/** How many analyzed tracks the engine can search over. Gates feature tiers. */
export async function featureCount(): Promise<number> {
  return (await load()).length
}

export async function getFeatureRow(ref: string): Promise<FeatureRow | null> {
  return (await load()).find(r => r.ref === ref) ?? null
}

export interface Neighbor extends FeatureRow { similarity: number }

/** k sound-nearest tracks to `ref` (excluding itself). maxPerArtist keeps one seed's
 *  soundalike catalog from flooding a queue. */
export async function nearestByRef(ref: string, k: number, opts: { maxPerArtist?: number } = {}): Promise<Neighbor[]> {
  const row = await getFeatureRow(ref)
  if (!row) return []
  return nearestToVector(row.embedding, k, { ...opts, excludeRefs: [ref] })
}

export async function nearestToVector(vec: Float32Array, k: number, opts: { maxPerArtist?: number; excludeRefs?: string[] } = {}): Promise<Neighbor[]> {
  const rows = await load()
  const exclude = new Set(opts.excludeRefs ?? [])
  const scored: Neighbor[] = []
  for (const r of rows) {
    if (exclude.has(r.ref)) continue
    scored.push({ ...r, similarity: dot(vec, r.embedding) })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  if (!opts.maxPerArtist) return scored.slice(0, k)
  const perArtist = new Map<string, number>()
  const out: Neighbor[] = []
  for (const s of scored) {
    const key = (s.artist ?? '').toLowerCase()
    const n = perArtist.get(key) ?? 0
    if (n >= opts.maxPerArtist) continue
    perArtist.set(key, n + 1)
    out.push(s)
    if (out.length >= k) break
  }
  return out
}

/** L2-normalised centroid of the given refs' embeddings (refs without features are
 *  skipped). Null when fewer than `min` contribute — a centroid of 2 tracks is noise. */
export async function centroidOf(refs: string[], min = 5): Promise<Float32Array | null> {
  const rows = await load()
  const byRef = new Map(rows.map(r => [r.ref, r]))
  const hit = refs.map(r => byRef.get(r)).filter((r): r is FeatureRow => !!r)
  if (hit.length < min) return null
  const dim = hit[0]!.embedding.length
  const c = new Float32Array(dim)
  for (const h of hit) for (let i = 0; i < dim; i++) c[i]! += h.embedding[i]!
  let norm = 0
  for (let i = 0; i < dim; i++) norm += c[i]! * c[i]!
  norm = Math.sqrt(norm)
  if (!norm) return null
  for (let i = 0; i < dim; i++) c[i]! /= norm
  return c
}

/** Tracks whose classifier tags overlap the wanted set, ranked by overlap count then
 *  (optionally) proximity to a target energy. Tags look like "hard rock" / "mood/epic". */
export async function tracksByTags(tags: string[], k: number, opts: { energy?: number } = {}): Promise<FeatureRow[]> {
  const want = new Set(tags.map(t => t.toLowerCase()))
  const rows = await load()
  const scored = rows
    .map(r => {
      const overlap = r.tags.reduce((n, t) => n + (want.has(t.toLowerCase()) ? 1 : 0), 0)
      const energyDist = opts.energy != null && r.energy != null ? Math.abs(opts.energy - r.energy) : 0
      return { r, score: overlap - energyDist * 0.5 }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(s => s.r)
}

/** Library tracks whose classifier tags appear in free text (a station's name + prompt).
 *  The matchable vocabulary is whatever tags the analyzed library actually has — a cold
 *  start matches nothing and the caller's tier contributes 0. */
export async function libraryTracksForText(text: string, k: number): Promise<FeatureRow[]> {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  const rows = await load()
  const vocab = new Set<string>()
  for (const r of rows) for (const t of r.tags) vocab.add(t.toLowerCase().replace(/^mood\//, ''))
  const wanted = [...vocab].filter(t => t.length >= 3 && hay.includes(` ${t} `))
  if (!wanted.length) return []
  return tracksByTags(wanted.flatMap(t => [t, `mood/${t}`]), k)
}

/** ref → classifier tags for every analyzed track (smart-playlist genre rules). */
export async function allFeatureTags(): Promise<Map<string, string[]>> {
  const rows = await load()
  return new Map(rows.map(r => [r.ref, r.tags]))
}

/** Substring search over the analyzed library (title/artist) — the picker vocabulary for
 *  features that need BOTH endpoints analyzed (Sonic Adventure). */
export async function searchFeatures(q: string, k = 12): Promise<FeatureRow[]> {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const rows = await load()
  const scored = rows
    .map(r => {
      const title = (r.title ?? '').toLowerCase()
      const artist = (r.artist ?? '').toLowerCase()
      const hit = title.includes(needle) || artist.includes(needle)
      if (!hit) return null
      // Prefix matches read as "better" hits than mid-string ones.
      const score = (title.startsWith(needle) ? 2 : 0) + (artist.startsWith(needle) ? 1 : 0)
      return { r, score }
    })
    .filter((s): s is { r: FeatureRow; score: number } => !!s)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(s => s.r)
}

/** Plexamp's Sonic Adventure: a path of analyzed tracks that gradually transitions from
 *  `fromRef`'s sound to `toRef`'s. Interpolates between the two embeddings on the unit
 *  sphere and picks the sound-nearest unused track at each waypoint, nudging for artist
 *  variety. Returns the full path INCLUDING both endpoints, or null when either endpoint
 *  hasn't been analyzed. */
export async function sonicAdventurePath(fromRef: string, toRef: string, steps = 12): Promise<FeatureRow[] | null> {
  const a = await getFeatureRow(fromRef)
  const b = await getFeatureRow(toRef)
  if (!a || !b) return null
  const used = new Set([fromRef, toRef])
  const path: FeatureRow[] = [a]
  const dim = a.embedding.length
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 1)
    // Lerp + renormalise ≈ slerp for these angles, and it's dimension-cheap.
    const v = new Float32Array(dim)
    let norm = 0
    for (let j = 0; j < dim; j++) {
      v[j] = a.embedding[j]! * (1 - t) + b.embedding[j]! * t
      norm += v[j]! * v[j]!
    }
    norm = Math.sqrt(norm)
    if (!norm) continue
    for (let j = 0; j < dim; j++) v[j]! /= norm
    const candidates = await nearestToVector(v, 6, { excludeRefs: [...used] })
    if (!candidates.length) continue
    const prevArtist = (path[path.length - 1]!.artist ?? '').toLowerCase()
    const pick = candidates.find(c => (c.artist ?? '').toLowerCase() !== prevArtist) ?? candidates[0]!
    used.add(pick.ref)
    path.push(pick)
  }
  path.push(b)
  return path
}
