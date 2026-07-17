// Listening Together: the in-memory household presence registry.
//
// Every app session with the player providers mounted heartbeats here (POST
// /api/together/presence, see routes/together.ts): a stable client device id, a
// user-agent-derived label, and a snapshot of what its player is doing. The registry
// is deliberately in-memory - live player state is ephemeral by nature and a stale
// entry ages out on its own. The only durable piece is the user-chosen device NAME,
// persisted in the player_devices table (merged in by the route layer).
//
// Command delivery to a chosen session rides the existing per-user browser-session
// SSE stream (lib/pod/browserSession.ts pushToDeviceSession), which registers the
// same device id at connect time.

export type PlayerSource = 'radio' | 'liveRadio' | 'podcast'

export interface PlayerSnapshot {
  source: PlayerSource
  title: string
  artist: string | null
  cover: string
  positionSec: number
  durationSec: number
  playing: boolean
  /** 0..1 - what the target's volume slider shows on the remote surface. */
  volume: number
}

export interface PresenceEntry {
  deviceId: string
  userId: string
  userName: string
  /** User-agent-derived default label ("Mac / Chrome"). */
  label: string
  /** Live player state, or null when the session is idle (still a valid target). */
  state: PlayerSnapshot | null
  lastSeenMs: number
}

// Heartbeats: ~5s while playing, ~20s idle (background tabs can be throttled to
// 60s, and audio-playing tabs are exempt from throttling). Anything not seen for
// STALE_MS is treated as gone.
const STALE_MS = 140_000

const entries = new Map<string, PresenceEntry>()

export function reportPresence(e: Omit<PresenceEntry, 'lastSeenMs'>): void {
  entries.set(e.deviceId, { ...e, lastSeenMs: Date.now() })
  // Opportunistic sweep so the map never grows unbounded.
  if (entries.size > 64) sweepStale()
}

export function clearPresence(deviceId: string, userId: string): void {
  const cur = entries.get(deviceId)
  if (cur && cur.userId === userId) entries.delete(deviceId)
}

function sweepStale(): void {
  const cutoff = Date.now() - STALE_MS
  for (const [id, e] of entries) if (e.lastSeenMs < cutoff) entries.delete(id)
}

/** All live sessions in the household, freshest first. */
export function listPresence(): PresenceEntry[] {
  sweepStale()
  return [...entries.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs)
}

export function getPresence(deviceId: string): PresenceEntry | null {
  sweepStale()
  return entries.get(deviceId) ?? null
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Resolve a spoken/typed target ("living room tv") against live sessions by their
 *  persisted custom name first, then the derived label. Exact match wins, then
 *  substring either way, then token overlap (every query token present). Returns
 *  null when nothing plausibly matches - callers must fall back to local playback. */
export function findPresenceByName(
  target: string,
  names: Map<string, string>,
): PresenceEntry | null {
  const q = norm(target)
  if (!q) return null
  const live = listPresence()
  const nameOf = (e: PresenceEntry) => norm(names.get(e.deviceId) ?? e.label)

  let hit = live.find((e) => nameOf(e) === q)
  if (hit) return hit
  hit = live.find((e) => nameOf(e).includes(q) || q.includes(nameOf(e)))
  if (hit) return hit
  const qTokens = q.split(' ').filter((t) => t.length > 1)
  if (!qTokens.length) return null
  return live.find((e) => {
    const n = nameOf(e)
    return qTokens.every((t) => n.includes(t))
  }) ?? null
}
