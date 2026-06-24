// Orchestrates AI podcasts for the Shows + Movies apps. A TV show maps to one podcast "show"
// whose episodes each discuss one TV episode, generated in batches (the first 5 on creation,
// then "generate next batch"). A movie maps to a podcast show with a single deep-dive episode.
//
// Reuses the existing podcast pipeline end-to-end: we create podcast_episodes + a download
// job per episode with a per-episode segment override (tvshow / movie), exactly like the
// YouTube auto-podcast path. The TV-episode / movie identity is recorded in
// podcast_episode_sources so "generate next batch" skips episodes already queued.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { podcastShows, podcastEpisodes, podcastEpisodeSources, downloadJobs, users } from '@/db/schema'
import { getVisibleCompanions } from '@/routes/companions'
import { getShowDetails, getShowEpisodes } from '@/lib/shows/tvmaze'
import type { ShowHost, ShowSegment } from './types'

export const BATCH_SIZE = 5

async function pickHosts(userId: string, isAdmin: boolean): Promise<ShowHost[]> {
  const companions = await getVisibleCompanions(userId, isAdmin)
  const ids = companions.slice(0, 2).map((c) => c.id)
  if (!ids.length) return []
  const roles: ShowHost['role'][] = ['host', 'co-host']
  return ids.map((characterId, i) => ({ characterId, role: roles[i] ?? 'co-host' }))
}

async function firstNameOf(userId: string): Promise<string> {
  const [row] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  return row?.firstName ?? 'user'
}

function enqueueEpisodeJob(opts: {
  showId: string
  episodeId: string
  userId: string
  firstName: string
  label: string
  segment: ShowSegment
  createdAt: Date
}): Promise<unknown> {
  const payload = JSON.stringify({
    showId: opts.showId,
    episodeId: opts.episodeId,
    userId: opts.userId,
    userFirstName: opts.firstName,
    segments: [opts.segment],
  })
  return db.insert(downloadJobs).values({
    id: crypto.randomUUID(),
    type: 'podcast-generate',
    refId: payload,
    domain: 'podcast',
    sizeClass: 'small',
    label: `Podcast: ${opts.label}`,
    status: 'pending',
    priority: 50,
    attempts: 0,
    maxAttempts: 3,
    variantKey: null,
    lastError: null,
    nextEligibleAt: null,
    progress: null,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  })
}

// ── TV shows ────────────────────────────────────────────────────────────────────

export async function ensureTvShowPodcast(tvmazeId: number, userId: string, isAdmin: boolean): Promise<{ id: string } | null> {
  const sourceRef = `tvshow:${tvmazeId}`
  const [existing] = await db
    .select()
    .from(podcastShows)
    .where(and(eq(podcastShows.ownerUserId, userId), eq(podcastShows.sourceRef, sourceRef)))
    .limit(1)
  if (existing) return { id: existing.id }

  const details = await getShowDetails(tvmazeId)
  if (!details) return null
  const hosts = await pickHosts(userId, isAdmin)
  if (!hosts.length) return null

  const id = crypto.randomUUID()
  await db.insert(podcastShows).values({
    id,
    ownerUserId: userId,
    name: `${details.name} — Episode by Episode`,
    description: `An episode-by-episode companion podcast for ${details.name}.`,
    style: 'recap',
    segmentsJson: '[]',
    hostsJson: JSON.stringify(hosts),
    visibility: 'personal',
    source: 'app',
    sourceRef,
    autoGenerate: false,
    createdAt: new Date(),
  })
  return { id }
}

async function sourcedEpisodeIds(podcastShowId: string): Promise<Set<string>> {
  const rows = await db
    .select({ sourceId: podcastEpisodeSources.sourceId })
    .from(podcastEpisodeSources)
    .innerJoin(podcastEpisodes, eq(podcastEpisodeSources.episodeId, podcastEpisodes.id))
    .where(and(eq(podcastEpisodes.showId, podcastShowId), eq(podcastEpisodeSources.sourceType, 'tvshow')))
  return new Set(rows.map((r) => r.sourceId))
}

export interface BatchResult {
  queued: number
  remaining: number
}

export async function queueTvShowBatch(
  podcastShowId: string,
  tvmazeId: number,
  userId: string,
  size = BATCH_SIZE,
): Promise<BatchResult> {
  const details = await getShowDetails(tvmazeId)
  const episodes = await getShowEpisodes(tvmazeId)
  const today = new Date().toISOString().slice(0, 10)
  const ordered = episodes
    .filter((e) => e.season > 0 && (!e.airdate || e.airdate <= today))
    .sort((a, b) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0))

  const done = await sourcedEpisodeIds(podcastShowId)
  const pending = ordered.filter((e) => !done.has(String(e.id)))
  const batch = pending.slice(0, size)
  if (!batch.length) return { queued: 0, remaining: 0 }

  const firstName = await firstNameOf(userId)
  const showName = details?.name ?? 'Show'
  const genres = details?.genres ?? []

  let i = 0
  for (const ep of batch) {
    const createdAt = new Date(Date.now() - i * 1000)
    const episodeId = crypto.randomUUID()
    const code = `S${ep.season}${ep.number != null ? `E${ep.number}` : ''}`
    await db.insert(podcastEpisodes).values({
      id: episodeId,
      showId: podcastShowId,
      title: `${code}: ${ep.name}`,
      status: 'pending',
      createdAt,
    })
    await db
      .insert(podcastEpisodeSources)
      .values({
        id: crypto.randomUUID(),
        episodeId,
        sourceType: 'tvshow',
        sourceId: String(ep.id),
        title: ep.name,
        createdAt,
      })
      .onConflictDoNothing()
    await enqueueEpisodeJob({
      showId: podcastShowId,
      episodeId,
      userId,
      firstName,
      label: `${showName} ${code}`,
      segment: {
        type: 'tvshow',
        label: showName,
        params: {
          tvmazeId,
          showName,
          season: ep.season,
          number: ep.number,
          episodeName: ep.name,
          synopsis: ep.summary,
          genres,
        },
      },
      createdAt,
    })
    i++
  }

  return { queued: batch.length, remaining: pending.length - batch.length }
}

export async function getTvShowPodcast(tvmazeId: number, userId: string): Promise<{
  showId: string
  episodes: Array<typeof podcastEpisodes.$inferSelect>
  remaining: number
} | null> {
  const sourceRef = `tvshow:${tvmazeId}`
  const [show] = await db
    .select()
    .from(podcastShows)
    .where(and(eq(podcastShows.ownerUserId, userId), eq(podcastShows.sourceRef, sourceRef)))
    .limit(1)
  if (!show) return null

  const episodes = await db
    .select()
    .from(podcastEpisodes)
    .where(eq(podcastEpisodes.showId, show.id))

  const episodesList = await getShowEpisodes(tvmazeId)
  const today = new Date().toISOString().slice(0, 10)
  const airedCount = episodesList.filter((e) => e.season > 0 && (!e.airdate || e.airdate <= today)).length
  const done = await sourcedEpisodeIds(show.id)
  return { showId: show.id, episodes, remaining: Math.max(0, airedCount - done.size) }
}

// ── Movies ──────────────────────────────────────────────────────────────────────

export async function ensureAndQueueMoviePodcast(
  title: string,
  year: number | null,
  overview: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ id: string; queued: boolean } | null> {
  const sourceRef = `movie:${title.toLowerCase()}`
  const [existing] = await db
    .select()
    .from(podcastShows)
    .where(and(eq(podcastShows.ownerUserId, userId), eq(podcastShows.sourceRef, sourceRef)))
    .limit(1)

  let showId: string
  if (existing) {
    showId = existing.id
  } else {
    const hosts = await pickHosts(userId, isAdmin)
    if (!hosts.length) return null
    showId = crypto.randomUUID()
    await db.insert(podcastShows).values({
      id: showId,
      ownerUserId: userId,
      name: `${title} — Deep Dive`,
      description: `A discussion & review podcast about the film ${title}.`,
      style: 'in-depth',
      segmentsJson: '[]',
      hostsJson: JSON.stringify(hosts),
      visibility: 'personal',
      source: 'app',
      sourceRef,
      autoGenerate: false,
      createdAt: new Date(),
    })
  }

  // One deep-dive episode per movie — skip if we already have one.
  const done = await db
    .select({ sourceId: podcastEpisodeSources.sourceId })
    .from(podcastEpisodeSources)
    .innerJoin(podcastEpisodes, eq(podcastEpisodeSources.episodeId, podcastEpisodes.id))
    .where(and(eq(podcastEpisodes.showId, showId), eq(podcastEpisodeSources.sourceType, 'movie')))
  if (done.length > 0) return { id: showId, queued: false }

  const firstName = await firstNameOf(userId)
  const createdAt = new Date()
  const episodeId = crypto.randomUUID()
  await db.insert(podcastEpisodes).values({
    id: episodeId,
    showId,
    title: `${title}${year ? ` (${year})` : ''}`,
    status: 'pending',
    createdAt,
  })
  await db
    .insert(podcastEpisodeSources)
    .values({ id: crypto.randomUUID(), episodeId, sourceType: 'movie', sourceId: title.toLowerCase(), title, createdAt })
    .onConflictDoNothing()
  await enqueueEpisodeJob({
    showId,
    episodeId,
    userId,
    firstName,
    label: title,
    segment: { type: 'movie', label: title, params: { title, year, overview } },
    createdAt,
  })
  return { id: showId, queued: true }
}

export async function getMoviePodcast(title: string, userId: string): Promise<{
  showId: string
  episodes: Array<typeof podcastEpisodes.$inferSelect>
} | null> {
  const sourceRef = `movie:${title.toLowerCase()}`
  const [show] = await db
    .select()
    .from(podcastShows)
    .where(and(eq(podcastShows.ownerUserId, userId), eq(podcastShows.sourceRef, sourceRef)))
    .limit(1)
  if (!show) return null
  const episodes = await db.select().from(podcastEpisodes).where(eq(podcastEpisodes.showId, show.id))
  return { showId: show.id, episodes }
}
