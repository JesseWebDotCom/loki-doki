// Client for the Podcasts portability endpoints: the private RSS-out token and the
// gPodder app password AntennaPod syncs with, plus podcast Replay / stats.

const opts: RequestInit = { credentials: 'include' }

async function jsonOrError<T>(r: Response, fallback: string): Promise<T> {
  const d = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw new Error(d?.error || fallback)
  return d as T
}

// ── RSS out ─────────────────────────────────────────────────────────────────────────

export async function getRssToken(): Promise<string> {
  const d = await jsonOrError<{ token: string }>(await fetch('/api/podcasts/portability/rss-token', opts), 'Could not load the feed token')
  return d.token
}

export async function regenerateRssToken(): Promise<string> {
  const d = await jsonOrError<{ token: string }>(
    await fetch('/api/podcasts/portability/rss-token/regenerate', { ...opts, method: 'POST' }),
    'Could not regenerate the feed token',
  )
  return d.token
}

export async function revokeRssToken(): Promise<void> {
  await jsonOrError(await fetch('/api/podcasts/portability/rss-token', { ...opts, method: 'DELETE' }), 'Could not revoke the feed token')
}

/** Absolute feed URL for a generated show, ready to paste into a podcatcher. */
export const showFeedUrl = (token: string, showId: string) =>
  `${window.location.origin}/api/podcast-rss/${token}/show/${showId}.xml`

/** Absolute feed URL for the whole radio-recordings collection. */
export const radioFeedUrl = (token: string) =>
  `${window.location.origin}/api/podcast-rss/${token}/radio.xml`

// ── gPodder sync ────────────────────────────────────────────────────────────────────

export interface GpodderStatus {
  configured: boolean
  username: string
  devices: Array<{ deviceId: string; caption: string | null; type: string | null; lastSeenAt: string | number | null }>
}

export async function getGpodderStatus(): Promise<GpodderStatus> {
  return jsonOrError(await fetch('/api/podcasts/portability/gpodder', opts), 'Could not load sync settings')
}

/** Returns the plaintext app password exactly once. */
export async function generateGpodderPassword(): Promise<{ username: string; password: string }> {
  return jsonOrError(
    await fetch('/api/podcasts/portability/gpodder/password', { ...opts, method: 'POST' }),
    'Could not generate an app password',
  )
}

export async function revokeGpodderPassword(): Promise<void> {
  await jsonOrError(
    await fetch('/api/podcasts/portability/gpodder/password', { ...opts, method: 'DELETE' }),
    'Could not revoke the app password',
  )
}

// ── Replay / stats ──────────────────────────────────────────────────────────────────

export interface PodcastReplay {
  year: number
  minutes: number
  episodes: number
  showCount: number
  topShows: Array<{ showId: string; name: string; episodes: number; minutes: number }>
  longestListen: { title: string; showId: string; showName: string; minutes: number } | null
  timeSavedSec: number
  household: {
    minutes: number
    episodes: number
    topShows: Array<{ showId: string; name: string; episodes: number; minutes: number }>
    byUser: Array<{ firstName: string; minutes: number; episodes: number }>
  } | null
}

export async function getPodcastReplay(year?: number): Promise<PodcastReplay> {
  return jsonOrError(await fetch(`/api/podcasts/replay${year ? `?year=${year}` : ''}`, opts), 'Could not load Replay')
}

export interface PodcastStats {
  totals: { episodes: number; minutes: number; shows: number }
  years: Array<{ year: number; episodes: number; minutes: number }>
  topShows: Array<{ showId: string; name: string; episodes: number; minutes: number }>
}

export async function getPodcastStats(): Promise<PodcastStats> {
  return jsonOrError(await fetch('/api/podcasts/stats', opts), 'Could not load podcast stats')
}
