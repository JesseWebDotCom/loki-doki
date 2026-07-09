// The user's music UNIVERSE: every track we can name that they have a relationship
// with - history plays, favorites, star ratings, offline downloads, and the family's
// local library. Smart playlists and Magic Vibe draw candidates from here (never from
// the open catalog - these are "playlists of YOUR music").

import { sqlite } from '@/db'
import { localRef } from '@/lib/music/trackRef'

export interface UniverseTrack {
  videoId: string          // unified ref
  title: string
  artist: string
  playCount: number
  lastPlayedMs: number | null
  stars: number | null     // 1-5
  favorite: boolean
}

export function getUserUniverse(userId: string): UniverseTrack[] {
  const map = new Map<string, UniverseTrack>()
  const upsert = (ref: string, title: string, artist: string | null) => {
    const cur = map.get(ref)
    if (cur) return cur
    const t: UniverseTrack = { videoId: ref, title, artist: artist ?? '', playCount: 0, lastPlayedMs: null, stars: null, favorite: false }
    map.set(ref, t)
    return t
  }

  // History (play counts + recency). played_at is unix SECONDS.
  const hist = sqlite.prepare(`
    SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, COUNT(*) AS plays, MAX(played_at) AS last_s
    FROM music_history WHERE user_id = ? GROUP BY video_id
  `).all(userId) as Array<{ video_id: string; title: string; artist: string | null; plays: number; last_s: number }>
  for (const r of hist) {
    if (!r.video_id || !r.title) continue
    const t = upsert(r.video_id, r.title, r.artist)
    t.playCount = r.plays
    t.lastPlayedMs = r.last_s * 1000
  }

  // Favorites (songs only).
  const favs = sqlite.prepare(`
    SELECT ref_id, title, artist FROM music_favorites WHERE user_id = ? AND kind = 'song'
  `).all(userId) as Array<{ ref_id: string; title: string | null; artist: string | null }>
  for (const r of favs) {
    if (!r.ref_id) continue
    upsert(r.ref_id, r.title ?? r.ref_id, r.artist).favorite = true
  }

  // Star ratings.
  const stars = sqlite.prepare(`
    SELECT ref, title, artist, stars FROM music_ratings WHERE user_id = ?
  `).all(userId) as Array<{ ref: string; title: string | null; artist: string | null; stars: number }>
  for (const r of stars) {
    if (!r.ref) continue
    upsert(r.ref, r.title ?? r.ref, r.artist).stars = r.stars
  }

  // The family's local library (playable files ARE part of everyone's universe).
  const local = sqlite.prepare(`
    SELECT id, title, artist FROM music_local_tracks WHERE browser_playable = 1
  `).all() as Array<{ id: string; title: string; artist: string | null }>
  for (const r of local) upsert(localRef(r.id), r.title, r.artist)

  return [...map.values()]
}
