// Playlist curation core — the shared engine behind "talk to build a playlist".
//
// Both the Magic Vibe HTTP route (musicPlaylists.ts) and the companion's
// curate_playlist tool drive these helpers, so a voice-built playlist behaves
// exactly like one built from the UI dialog: the LLM proposes real songs for the
// brief, the resolver makes them playable, prefer-library swaps in owned copies,
// and the parental filter drops anything a profile shouldn't see. Nothing here
// speaks to the client — callers persist a plain, editable playlist (kind 'magic',
// recipe kept in rules_json so Regenerate / "make it more X" can re-roll it).

import { eq, asc, max } from 'drizzle-orm'
import { db } from '@/db'
import { musicPlaylists, musicPlaylistTracks } from '@/db/schema'
import { llmTracklist } from '@/lib/music/stationEngine'
import { resolveTracks, type ResolvedTrack } from '@/lib/music/resolve'
import { preferLibrary } from '@/lib/music/resolveSource'
import { filterTracksForUser } from '@/lib/music/advisory'

export interface CurateRecipe {
  vibe: string
  chips?: string[]
  arc?: string
  count?: number
}

export class CurateError extends Error {
  constructor(public code: 'insufficient' | 'not_magic', message: string) {
    super(message)
    this.name = 'CurateError'
  }
}

const ARC_TEXT: Record<string, string> = {
  rise: ' Order the playlist as a rising energy arc (mellow start, big finish).',
  fall: ' Order the playlist as a falling energy arc (big start, wind-down finish).',
  wave: ' Order the playlist as a wave energy arc (build, release, build again).',
}

/** Fold the vibe + optional sonic chips + energy arc into a single LLM brief. */
export function buildBrief(recipe: CurateRecipe): string {
  const chips = (recipe.chips ?? []).filter(Boolean)
  const arc = recipe.arc && arc_ok(recipe.arc) ? recipe.arc : 'flat'
  return `${recipe.vibe}${chips.length ? `. Sonic direction: ${chips.join(', ')}` : ''}.` +
    (arc !== 'flat' ? (ARC_TEXT[arc] ?? '') : '')
}
function arc_ok(a: string): boolean {
  return a === 'rise' || a === 'fall' || a === 'wave'
}

/** Vibe → concrete, playable, profile-safe tracklist. The shared generation step. */
export async function generateCuratedTracks(userId: string, recipe: CurateRecipe): Promise<ResolvedTrack[]> {
  const count = Math.max(4, Math.min(40, recipe.count ?? 20))
  const brief = buildBrief({ ...recipe, count })
  const proposed = await llmTracklist({ name: recipe.vibe.slice(0, 60), aiPrompt: brief }, count)
  const resolved = await resolveTracks(proposed.map(t => ({ title: t.title, artist: t.artist })), 8)
  const withOwned = await preferLibrary(resolved)
  return filterTracksForUser(userId, withOwned)
}

function trackRows(playlistId: string, tracks: ResolvedTrack[], startPos: number, now: Date) {
  return tracks.map((t, i) => ({
    id: crypto.randomUUID(), playlistId, videoId: t.videoId, title: t.title,
    artist: t.artist || null, mbid: null, durationSec: t.durationSec, position: startPos + i, addedAt: now,
  }))
}

/** Generate + persist a brand-new curated playlist (kind 'magic'). Throws
 *  CurateError('insufficient') when the vibe yields too few playable songs. */
export async function createCuratedPlaylist(
  userId: string,
  opts: { vibe: string; chips?: string[]; arc?: string; count?: number; name?: string; description?: string },
): Promise<{ id: string; name: string; trackCount: number }> {
  const count = Math.max(8, Math.min(40, opts.count ?? 20))
  const tracks = await generateCuratedTracks(userId, { vibe: opts.vibe, chips: opts.chips, arc: opts.arc, count })
  if (tracks.length < 5) throw new CurateError('insufficient', 'Could not find enough songs for that vibe.')
  const id = crypto.randomUUID()
  const now = new Date()
  const name = opts.name?.trim() || opts.vibe.slice(0, 60)
  await db.insert(musicPlaylists).values({
    id, userId, name, description: opts.description ?? `Curated: ${opts.vibe}`,
    visibility: 'private', kind: 'magic',
    rulesJson: JSON.stringify({ vibe: opts.vibe, chips: opts.chips ?? [], arc: opts.arc ?? 'flat', count }),
    generatedAt: now, createdAt: now, updatedAt: now,
  })
  await db.insert(musicPlaylistTracks).values(trackRows(id, tracks, 0, now))
  return { id, name, trackCount: tracks.length }
}

/** Append already-resolved tracks to a playlist, de-duped against what's there. */
export async function appendCuratedTracks(playlistId: string, tracks: ResolvedTrack[]): Promise<number> {
  if (!tracks.length) return 0
  const existing = await db.select({ videoId: musicPlaylistTracks.videoId })
    .from(musicPlaylistTracks).where(eq(musicPlaylistTracks.playlistId, playlistId))
  const have = new Set(existing.map(r => r.videoId))
  const fresh = tracks.filter(t => !have.has(t.videoId))
  if (!fresh.length) return 0
  const now = new Date()
  const [{ maxPos } = { maxPos: null }] = await db
    .select({ maxPos: max(musicPlaylistTracks.position) })
    .from(musicPlaylistTracks).where(eq(musicPlaylistTracks.playlistId, playlistId))
  await db.insert(musicPlaylistTracks).values(trackRows(playlistId, fresh, (maxPos ?? -1) + 1, now))
  await db.update(musicPlaylists).set({ updatedAt: now }).where(eq(musicPlaylists.id, playlistId))
  return fresh.length
}

/** Generate tracks for a sub-brief (e.g. "some Bad Bunny") and append them. */
export async function addToCuratedPlaylist(
  userId: string, playlistId: string, subBrief: string, count = 5,
): Promise<{ added: number }> {
  const tracks = await generateCuratedTracks(userId, { vibe: subBrief, count })
  return { added: await appendCuratedTracks(playlistId, tracks) }
}

/** Remove the last (highest-position) track. Returns what was removed, or null if empty. */
export async function removeLastTrack(playlistId: string): Promise<{ title: string; artist: string | null } | null> {
  const rows = await db.select().from(musicPlaylistTracks)
    .where(eq(musicPlaylistTracks.playlistId, playlistId)).orderBy(asc(musicPlaylistTracks.position))
  const last = rows[rows.length - 1]
  if (!last) return null
  await db.delete(musicPlaylistTracks).where(eq(musicPlaylistTracks.id, last.id))
  await db.update(musicPlaylists).set({ updatedAt: new Date() }).where(eq(musicPlaylists.id, playlistId))
  return { title: last.title, artist: last.artist }
}

/** Remove the best title/artist match named in a free-text query ("take out that Drake song"). */
export async function removeMatchingTrack(
  playlistId: string, query: string,
): Promise<{ title: string; artist: string | null } | null> {
  const rows = await db.select().from(musicPlaylistTracks)
    .where(eq(musicPlaylistTracks.playlistId, playlistId)).orderBy(asc(musicPlaylistTracks.position))
  if (!rows.length) return null
  const q = query.toLowerCase()
  // Prefer a title mentioned in the query; fall back to an artist mention.
  const byTitle = rows.find(r => r.title && q.includes(r.title.toLowerCase()))
  const byArtist = rows.find(r => r.artist && q.includes(r.artist.toLowerCase()))
  const hit = byTitle ?? byArtist
  if (!hit) return null
  await db.delete(musicPlaylistTracks).where(eq(musicPlaylistTracks.id, hit.id))
  await db.update(musicPlaylists).set({ updatedAt: new Date() }).where(eq(musicPlaylists.id, playlistId))
  return { title: hit.title, artist: hit.artist }
}

/** Re-roll a magic playlist from its stored recipe, optionally folding in an extra
 *  direction ("make it more upbeat"). The evolved recipe is persisted so adjustments
 *  stack. Throws CurateError('not_magic') for non-magic playlists. */
export async function regenerateFromRecipe(
  userId: string, playlistId: string, extraDirection?: string,
): Promise<number> {
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, playlistId))
  if (!row || row.kind !== 'magic' || !row.rulesJson) {
    throw new CurateError('not_magic', 'not a magic playlist')
  }
  const recipe = JSON.parse(row.rulesJson) as CurateRecipe
  const merged: CurateRecipe = extraDirection
    ? { ...recipe, vibe: `${recipe.vibe}. ${extraDirection}` }
    : recipe
  const tracks = await generateCuratedTracks(userId, merged)
  if (tracks.length < 5) throw new CurateError('insufficient', 'Could not find enough songs to re-roll.')
  const now = new Date()
  await db.delete(musicPlaylistTracks).where(eq(musicPlaylistTracks.playlistId, playlistId))
  await db.insert(musicPlaylistTracks).values(trackRows(playlistId, tracks, 0, now))
  await db.update(musicPlaylists)
    .set({ rulesJson: JSON.stringify(merged), generatedAt: now, updatedAt: now })
    .where(eq(musicPlaylists.id, playlistId))
  return tracks.length
}
