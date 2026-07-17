// Weekly parent digest: per-child listening for the previous week (total minutes, top
// artists and shows, guardrail events), plus a short friendly LLM summary when the chat
// model is reachable. Stored in family_audio_digests and announced to admins via an
// admin-targeted 'system' notification. Runs Monday morning; the poller wakes hourly
// and an app_settings last-run key keeps it once-per-week (serverUpdate.ts pattern).

import { db } from '@/db'
import {
  familyAudioDigests, familyAudioEvents, familyAudioUsage,
  musicHistory, podcastWatchState, podcastEpisodes, podcastShows, users,
} from '@/db/schema'
import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { emitNotification } from '@/lib/notify'
import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { familyAudioSettingsFor, localDayKey } from '@/lib/family/audioPolicy'
import { logger } from '@/lib/logger'

const LAST_RUN_KEY = 'family_audio.digest.last_week_start'
const CHECK_INTERVAL_MS = 60 * 60 * 1000     // wake hourly; the week key gates real work
const RUN_AFTER_HOUR = 8                     // Monday 08:00 local

export interface ChildDigest {
  userId: string
  name: string
  totalMinutes: number
  musicMinutes: number
  podcastMinutes: number
  dailyBudgetMinutes: number | null
  daysNearBudget: number                     // days at >= 80% of the budget
  topArtists: Array<{ name: string; plays: number }>
  topShows: Array<{ name: string; episodes: number }>
  blockedAttempts: number
  blockedLabels: string[]
}

export interface DigestPayload {
  weekStart: string
  weekEnd: string
  children: ChildDigest[]
}

/** Monday 00:00 local of the week containing `d`. */
export function weekStartOf(d = new Date()): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (out.getDay() + 6) % 7          // Monday = 0
  out.setDate(out.getDate() - dow)
  return out
}

async function buildChildDigest(userId: string, name: string, from: Date, to: Date): Promise<ChildDigest> {
  const settings = await familyAudioSettingsFor(userId)

  // Total minutes from the usage ledger (day keys are local YYYY-MM-DD strings).
  const fromKey = localDayKey(from)
  const toKey = localDayKey(to)
  const usageRows = await db.select().from(familyAudioUsage)
    .where(and(eq(familyAudioUsage.userId, userId), gte(familyAudioUsage.day, fromKey), lt(familyAudioUsage.day, toKey)))
  let musicSec = 0
  let podcastSec = 0
  const perDay = new Map<string, number>()
  for (const r of usageRows) {
    if (r.medium === 'music') musicSec += r.seconds
    else podcastSec += r.seconds
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.seconds)
  }
  let daysNearBudget = 0
  if (settings.dailyAudioMinutes != null && settings.dailyAudioMinutes > 0) {
    for (const sec of perDay.values()) {
      if (sec >= settings.dailyAudioMinutes * 60 * 0.8) daysNearBudget++
    }
  }

  // Top artists from music history in the window.
  const history = await db.select({ artist: musicHistory.artist })
    .from(musicHistory)
    .where(and(eq(musicHistory.userId, userId), gte(musicHistory.playedAt, from), lt(musicHistory.playedAt, to)))
  const artistPlays = new Map<string, number>()
  for (const h of history) {
    const a = (h.artist ?? '').trim()
    if (!a) continue
    artistPlays.set(a, (artistPlays.get(a) ?? 0) + 1)
  }
  const topArtists = [...artistPlays.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([artist, plays]) => ({ name: artist, plays }))

  // Top podcast shows: episodes the child touched during the week.
  const watched = await db.select({ episodeId: podcastWatchState.episodeId })
    .from(podcastWatchState)
    .where(and(eq(podcastWatchState.userId, userId), gte(podcastWatchState.updatedAt, from), lt(podcastWatchState.updatedAt, to)))
  const topShows: Array<{ name: string; episodes: number }> = []
  if (watched.length) {
    const eps = await db.select({ id: podcastEpisodes.id, showId: podcastEpisodes.showId })
      .from(podcastEpisodes).where(inArray(podcastEpisodes.id, watched.map(w => w.episodeId).slice(0, 400)))
    const byShow = new Map<string, number>()
    for (const e of eps) byShow.set(e.showId, (byShow.get(e.showId) ?? 0) + 1)
    const showIds = [...byShow.keys()]
    const showRows = showIds.length
      ? await db.select({ id: podcastShows.id, name: podcastShows.name }).from(podcastShows).where(inArray(podcastShows.id, showIds))
      : []
    const names = new Map(showRows.map(s => [s.id, s.name]))
    topShows.push(...[...byShow.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, episodes]) => ({ name: names.get(id) ?? 'Unknown show', episodes })))
  }

  // Guardrail events in the window.
  const events = await db.select().from(familyAudioEvents)
    .where(and(eq(familyAudioEvents.userId, userId), gte(familyAudioEvents.createdAt, from), lt(familyAudioEvents.createdAt, to)))
  const blocked = events.filter(e => e.kind === 'blocked_play')
  const blockedLabels = [...new Set(blocked.map(e => {
    try { return (JSON.parse(e.detail ?? '{}') as { label?: string }).label ?? '' } catch { return '' }
  }).filter(Boolean))].slice(0, 8)

  return {
    userId, name,
    totalMinutes: Math.round((musicSec + podcastSec) / 60),
    musicMinutes: Math.round(musicSec / 60),
    podcastMinutes: Math.round(podcastSec / 60),
    dailyBudgetMinutes: settings.dailyAudioMinutes,
    daysNearBudget,
    topArtists, topShows,
    blockedAttempts: blocked.length,
    blockedLabels,
  }
}

/** Friendly two-to-four sentence summary via the fast model; null when unavailable. */
async function summarize(payload: DigestPayload): Promise<string | null> {
  try {
    const kids = payload.children.filter(k => k.totalMinutes > 0 || k.blockedAttempts > 0)
    if (!kids.length) return null
    const facts = kids.map(k => {
      const bits = [
        `${k.name}: ${k.totalMinutes} min total (${k.musicMinutes} music, ${k.podcastMinutes} podcasts)`,
        k.topArtists.length ? `top artists ${k.topArtists.slice(0, 3).map(a => a.name).join(', ')}` : '',
        k.topShows.length ? `top shows ${k.topShows.slice(0, 3).map(s => s.name).join(', ')}` : '',
        k.blockedAttempts ? `${k.blockedAttempts} blocked play attempts` : '',
        k.daysNearBudget ? `${k.daysNearBudget} days near the time budget` : '',
      ].filter(Boolean)
      return bits.join('; ')
    }).join('\n')
    const model = await getFastModel()
    const res = await ollamaChat(model, [
      {
        role: 'system',
        content: 'You write a short, warm weekly note to parents about their kids\' listening habits in a family audio app. 2 to 4 sentences, plain text, friendly and factual, no advice unless something was blocked repeatedly. Never use em dashes.',
      },
      { role: 'user', content: `Weekly listening facts:\n${facts}` },
    ], undefined, { temperature: 0.4 }, undefined, 60_000)
    const text = res.message?.content?.trim()
    return text ? text.replace(/—/g, ', ') : null
  } catch (err) {
    logger.debug(`[familyAudio] digest summary skipped: ${String(err)}`)
    return null
  }
}

/** Build + store the digest for the week starting at `weekStart` (defaults to last week). */
export async function runFamilyAudioDigest(weekStart?: Date): Promise<DigestPayload> {
  const thisWeek = weekStartOf()
  const start = weekStart ?? new Date(thisWeek.getTime() - 7 * 24 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)
  const weekKey = localDayKey(start)

  const allUsers = await db.select({ id: users.id, firstName: users.firstName, nickname: users.nickname, role: users.role }).from(users)
  const children: ChildDigest[] = []
  for (const u of allUsers) {
    if (u.role === 'admin') continue
    const name = u.nickname || u.firstName
    children.push(await buildChildDigest(u.id, name, start, end))
  }

  const payload: DigestPayload = { weekStart: weekKey, weekEnd: localDayKey(new Date(end.getTime() - 1)), children }
  const summary = await summarize(payload)

  await db.insert(familyAudioDigests)
    .values({ id: crypto.randomUUID(), weekStart: weekKey, payload: JSON.stringify(payload), summary, createdAt: new Date() })
    .onConflictDoUpdate({
      target: familyAudioDigests.weekStart,
      set: { payload: JSON.stringify(payload), summary, createdAt: new Date() },
    })

  const active = children.filter(k => k.totalMinutes > 0 || k.blockedAttempts > 0)
  if (active.length) {
    await emitNotification({
      type: 'system',
      userId: null,
      priority: 'info',
      title: 'Weekly family audio digest',
      body: summary ?? active.map(k => `${k.name}: ${k.totalMinutes} min`).join(', '),
      url: '/admin/family-audio',
      dedupeKey: `family-audio-digest:${weekKey}`,
      payload: { kind: 'family_audio_digest', weekStart: weekKey },
    })
  }
  return payload
}

let _timer: ReturnType<typeof setInterval> | null = null
let _running = false

async function tick(): Promise<void> {
  if (_running) return
  _running = true
  try {
    const now = new Date()
    const thisWeek = weekStartOf(now)
    if (now.getTime() < thisWeek.getTime() + RUN_AFTER_HOUR * 60 * 60 * 1000) return
    const thisWeekKey = localDayKey(thisWeek)
    const last = await getAppSetting(LAST_RUN_KEY)
    if (typeof last === 'string' && last >= thisWeekKey) return
    await runFamilyAudioDigest()
    await setAppSetting(LAST_RUN_KEY, thisWeekKey)
    logger.info(`[familyAudio] weekly digest written for week ${thisWeekKey}`)
  } catch (err) {
    logger.debug(`[familyAudio] digest tick failed: ${String(err)}`)
  } finally {
    _running = false
  }
}

export function startFamilyAudioDigestPoller(): void {
  if (_timer) return
  _timer = setInterval(() => { void tick() }, CHECK_INTERVAL_MS)
  // One early check shortly after boot so a server that was off on Monday morning
  // still writes the digest the next time it comes up.
  setTimeout(() => { void tick() }, 90_000)
}
