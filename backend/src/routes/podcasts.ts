// Podcast shows, episodes, and suggestions CRUD + generation trigger.

import { Hono } from 'hono'
import { db } from '@/db'
import { podcastShows, podcastEpisodes, podcastEpisodeSources, podcastSuggestions, podcastSubscriptions, podcastDownloads, podcastWatchState, mediaAssets, users, characters, downloadJobs } from '@/db/schema'
import { eq, and, or, desc, inArray } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import { resolveUserPath, userPath, toRelativePath } from '@/lib/storage/paths'
import { ensureStingerSoundfont } from '@/lib/download'
import { getOrFetchProxyImage } from '@/lib/imageProxy'
import { acquireRead, releaseRead, blobAbsPath } from '@/lib/content/store'
import { enclosureFormat, formatContentType } from '@/lib/podcast/offline'
import { safeFetch } from '@/lib/ssrfGuard'
import { ollamaChat, ollamaList } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { cleanAutoTitle, cleanAutoText } from '@/lib/cleanTitle'
import { createReadStream, statSync } from 'node:fs'
import { writeFile, unlink } from 'node:fs/promises'
import type { ScriptTurn } from '@/lib/podcast/types'
import type { AppEnv } from '@/types'

export const podcastsRoute = new Hono<AppEnv>()
podcastsRoute.use('*', requireAuth)

// ── Access control ─────────────────────────────────────────────────────────────
// A user may VIEW a show/episode if they own it, it's shared, or they're an admin;
// only the owner (or an admin) may MUTATE it. Episode routes look the parent show up
// rather than trusting a bare episode id, so personal episodes can't be read by guessing.
type Actor = { id: string; role: string }
type ShowAccess = { ownerUserId: string; visibility: string | null; source?: string | null }
// RSS shows (real subscribed podcasts) are public content — any household member may
// view/play them; access nuance lives in subscription rows, not visibility.
const canSeeShow = (s: ShowAccess, u: Actor) => s.ownerUserId === u.id || s.visibility === 'shared' || s.source === 'rss' || u.role === 'admin'
const canEditShow = (s: ShowAccess, u: Actor) => s.ownerUserId === u.id || u.role === 'admin'
// RSS shows/episodes are managed by their feed — generate/edit/upload never applies.
const isRssShow = (s: ShowAccess) => s.source === 'rss'

async function showAccessForEpisode(episodeId: string): Promise<ShowAccess | null> {
  const [row] = await db.select({ ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
    .from(podcastEpisodes)
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(eq(podcastEpisodes.id, episodeId))
  return row ?? null
}

// DB-stored JSON config must never 500 a list when one row is malformed.
function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

// ── Shows ────────────────────────────────────────────────────────────────────

// Personal shows + every shared show, with owner name + hosts/segments resolved.
// Shared by GET /shows and GET /feed so the two stay consistent.
async function loadVisibleShows(user: Actor) {
  // RSS shows the user subscribed to are visible regardless of owner/visibility —
  // membership lives in podcast_subscriptions (the show row is shared household-wide).
  const subRows = await db.select().from(podcastSubscriptions)
    .where(eq(podcastSubscriptions.userId, user.id))
  const subMap = new Map(subRows.map(s => [s.showId, s]))

  const shows = await db.select({
    id: podcastShows.id,
    ownerUserId: podcastShows.ownerUserId,
    name: podcastShows.name,
    description: podcastShows.description,
    coverRelPath: podcastShows.coverRelPath,
    style: podcastShows.style,
    hostsJson: podcastShows.hostsJson,
    segmentsJson: podcastShows.segmentsJson,
    visibility: podcastShows.visibility,
    source: podcastShows.source,
    sourceRef: podcastShows.sourceRef,
    autoGenerate: podcastShows.autoGenerate,
    targetMinutes: podcastShows.targetMinutes,
    feedUrl: podcastShows.feedUrl,
    artworkUrl: podcastShows.artworkUrl,
    author: podcastShows.author,
    link: podcastShows.link,
    categoriesJson: podcastShows.categoriesJson,
    feedError: podcastShows.feedError,
    createdAt: podcastShows.createdAt,
  }).from(podcastShows)
    // Push the visibility filter into SQL (indexed on owner_user_id) instead of scanning
    // every user's shows into memory.
    .where(or(
      eq(podcastShows.ownerUserId, user.id),
      eq(podcastShows.visibility, 'shared'),
      ...(subMap.size ? [inArray(podcastShows.id, [...subMap.keys()])] : []),
    ))
    .orderBy(desc(podcastShows.createdAt))

  const ownerIds = [...new Set(shows.map(s => s.ownerUserId))]
  const owners = ownerIds.length
    ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users).where(inArray(users.id, ownerIds))
    : []
  const ownerMap = Object.fromEntries(owners.map(o => [o.id, o]))

  return shows
    // An RSS show someone ELSE subscribed to isn't in this user's library until they
    // subscribe too (discovery happens in the browse directory, not the shows list).
    .filter(s => s.source !== 'rss' || subMap.has(s.id))
    .map(s => {
      const sub = subMap.get(s.id)
      return {
        ...s,
        hosts: safeParse(s.hostsJson, [] as unknown[]),
        segments: safeParse(s.segmentsJson, [] as unknown[]),
        categories: safeParse(s.categoriesJson, [] as string[]),
        ownerName: ownerMap[s.ownerUserId] ? `${ownerMap[s.ownerUserId]!.firstName}`.trim() : 'Unknown',
        isOwn: s.ownerUserId === user.id,
        subscription: sub ? { autoDownload: sub.autoDownload, autoDownloadKeep: sub.autoDownloadKeep } : null,
      }
    })
}

podcastsRoute.get('/shows', async (c) => {
  return c.json({ shows: await loadVisibleShows(c.get('user')) })
})

// Combined feed: all visible shows + their episodes in a few queries, so the podcast
// landing pages don't fan out one /episodes request per show (a 1+M-request waterfall).
podcastsRoute.get('/feed', async (c) => {
  const user = c.get('user')
  const shows = await loadVisibleShows(user)
  const showIds = shows.map(s => s.id)

  const episodes = showIds.length
    ? await db.select().from(podcastEpisodes)
        .where(inArray(podcastEpisodes.showId, showIds))
        // RSS episodes sort by their real publish date; generated ones (null publishedAt)
        // fall through to createdAt (SQLite DESC puts NULLs last).
        .orderBy(desc(podcastEpisodes.publishedAt), desc(podcastEpisodes.createdAt))
    : []

  const epIds = episodes.map(e => e.id)
  const watchRows = epIds.length
    ? await db.select().from(podcastWatchState)
        .where(and(eq(podcastWatchState.userId, user.id), inArray(podcastWatchState.episodeId, epIds)))
    : []
  const watchMap = new Map(watchRows.map(w => [w.episodeId, w]))
  const downloadMap = await userDownloadMap(user.id, epIds)

  const episodesByShow: Record<string, unknown[]> = {}
  for (const id of showIds) episodesByShow[id] = []
  for (const e of episodes) {
    ;(episodesByShow[e.showId] ??= []).push({
      ...e,
      chapters: safeParse(e.chaptersJson, [] as unknown[]),
      watchState: watchMap.get(e.id) ?? null,
      download: downloadMap.get(e.id) ?? null,
    })
  }

  return c.json({ shows, episodesByShow })
})

/** This user's offline refs for a set of episodes → { status, auto } per episode id. */
async function userDownloadMap(userId: string, episodeIds: string[]): Promise<Map<string, { status: string; auto: boolean }>> {
  if (!episodeIds.length) return new Map()
  const rows: Array<{ episodeId: string; status: string; auto: boolean }> = []
  for (let i = 0; i < episodeIds.length; i += 400) {
    rows.push(...await db.select({ episodeId: podcastDownloads.episodeId, status: podcastDownloads.status, auto: podcastDownloads.auto })
      .from(podcastDownloads)
      .where(and(eq(podcastDownloads.userId, userId), inArray(podcastDownloads.episodeId, episodeIds.slice(i, i + 400)))))
  }
  return new Map(rows.map(r => [r.episodeId, { status: r.status, auto: r.auto }]))
}

// Reverse link: episodes generated from a given YouTube video, visible to this user.
// Powers the "Featured in podcasts" shelf on the YouTube watch page.
podcastsRoute.get('/by-video/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')

  const rows = await db.select({
    episodeId: podcastEpisodes.id,
    title: podcastEpisodes.title,
    durationSec: podcastEpisodes.durationSec,
    generatedAt: podcastEpisodes.generatedAt,
    showId: podcastShows.id,
    showName: podcastShows.name,
    ownerUserId: podcastShows.ownerUserId,
    visibility: podcastShows.visibility,
  })
    .from(podcastEpisodeSources)
    .innerJoin(podcastEpisodes, eq(podcastEpisodeSources.episodeId, podcastEpisodes.id))
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(and(
      eq(podcastEpisodeSources.sourceType, 'youtube'),
      eq(podcastEpisodeSources.sourceId, videoId),
      eq(podcastEpisodes.status, 'ready'),
    ))
    .orderBy(desc(podcastEpisodes.generatedAt))

  const episodes = rows
    .filter(r => r.ownerUserId === user.id || r.visibility === 'shared')
    .map(r => ({
      episodeId: r.episodeId,
      title: r.title,
      durationSec: r.durationSec,
      showId: r.showId,
      showName: r.showName,
      coverUrl: `/api/podcasts/shows/${r.showId}/cover`,
    }))

  return c.json({ episodes })
})

podcastsRoute.post('/shows', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    name: string; description?: string; style?: string
    hosts?: { characterId: string; role: string }[]
    segments?: { type: string; label?: string; params?: Record<string, unknown> }[]
    visibility?: 'personal' | 'shared'
    sourceRef?: string
  }>()

  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400)

  const sourceRef = body.sourceRef?.trim() || null
  // Shows built from a YouTube source (sourceRef set) take their title from the channel/
  // playlist name — scrub em dashes & emoji. User-authored show titles are left as typed.
  const name = sourceRef ? cleanAutoTitle(body.name) || body.name.trim() : body.name.trim()

  const id = crypto.randomUUID()
  await db.insert(podcastShows).values({
    id,
    ownerUserId: user.id,
    name,
    description: body.description ?? null,
    style: (body.style ?? 'recap') as any,
    hostsJson: JSON.stringify(body.hosts ?? []),
    segmentsJson: JSON.stringify(body.segments ?? []),
    visibility: body.visibility ?? 'personal',
    source: 'user',
    sourceRef,
    targetMinutes: (body as { targetMinutes?: number | null }).targetMinutes ?? null,
    createdAt: new Date(),
  })

  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, id))
  return c.json({ show })
})

podcastsRoute.put('/shows/:id', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('id')
  const body = await c.req.json<{
    name?: string; description?: string; style?: string
    hosts?: unknown[]; segments?: unknown[]
    visibility?: 'personal' | 'shared'
    autoGenerate?: boolean
    targetMinutes?: number | null
  }>()

  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show) return c.json({ error: 'Not found' }, 404)
  if (show.ownerUserId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  if (isRssShow(show)) return c.json({ error: 'Subscribed podcasts are managed by their feed' }, 400)

  await db.update(podcastShows).set({
    ...(body.name !== undefined && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.style !== undefined && { style: body.style as any }),
    ...(body.hosts !== undefined && { hostsJson: JSON.stringify(body.hosts) }),
    ...(body.segments !== undefined && { segmentsJson: JSON.stringify(body.segments) }),
    ...(body.visibility !== undefined && { visibility: body.visibility }),
    ...(typeof body.autoGenerate === 'boolean' && { autoGenerate: body.autoGenerate }),
    ...('targetMinutes' in body && { targetMinutes: body.targetMinutes ?? null }),
  }).where(eq(podcastShows.id, showId))

  return c.json({ ok: true })
})

podcastsRoute.delete('/shows/:id', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('id')
  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show) return c.json({ error: 'Not found' }, 404)
  if (show.ownerUserId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  // RSS shows are shared household-wide — leaving is unsubscribing, not deleting the
  // household's copy. Admins may still hard-delete.
  if (isRssShow(show) && user.role !== 'admin') return c.json({ error: 'Unsubscribe instead of deleting' }, 400)

  // Gather every on-disk artifact BEFORE deleting rows (episodes cascade away on the
  // DB delete, but their files — and the cover/stinger — would otherwise leak).
  const relPaths: string[] = []
  if (show.coverRelPath) relPaths.push(show.coverRelPath)
  if (show.stingerJson) {
    try {
      const s = JSON.parse(show.stingerJson) as { introRelPath?: string; outroRelPath?: string; transitionRelPath?: string }
      for (const p of [s.introRelPath, s.outroRelPath, s.transitionRelPath]) if (p) relPaths.push(p)
    } catch { /* malformed stinger json — nothing to clean */ }
  }
  const eps = await db.select({ audioRelPath: podcastEpisodes.audioRelPath })
    .from(podcastEpisodes).where(eq(podcastEpisodes.showId, showId))
  for (const e of eps) if (e.audioRelPath) relPaths.push(e.audioRelPath)

  await db.delete(podcastShows).where(eq(podcastShows.id, showId))

  // Best-effort cleanup — a missing/locked file must never fail the delete.
  for (const rel of relPaths) {
    try { await unlink(await resolveUserPath(rel)) } catch { /* already gone / unresolved */ }
  }
  return c.json({ ok: true })
})

// ── AI-written show description ───────────────────────────────────────────────
// Generates a short, vivid show blurb from the selection (hosts + source + its
// about text + sample topics). The client falls back to a local template if this
// fails (offline / model not installed).
podcastsRoute.post('/describe', async (c) => {
  const body = await c.req.json<{
    hosts?: string[]
    showName?: string
    sourceName?: string
    sourceKind?: 'channel' | 'playlist'
    sourceDescription?: string
    style?: string
    sampleTitles?: string[]
  }>().catch(() => ({} as Record<string, never>))

  const hosts = (body.hosts ?? []).filter(Boolean).slice(0, 6)
  const ctx: string[] = []
  if (body.showName?.trim()) ctx.push(`The show is titled "${body.showName.trim()}". This is its real, fixed title — do not invent or substitute another.`)
  ctx.push(`Hosts: ${hosts.length ? hosts.join(', ') : 'AI hosts'}.`)
  ctx.push(`Format: ${body.style ?? 'recap'}.`)
  if (body.sourceName) ctx.push(`The show covers content from the YouTube ${body.sourceKind ?? 'channel'} "${body.sourceName}" — that ${body.sourceKind ?? 'channel'} is the show's subject.`)
  if (body.sourceDescription?.trim()) ctx.push(`About that ${body.sourceKind ?? 'channel'}: ${body.sourceDescription.trim().slice(0, 700)}`)
  if (body.sampleTitles?.length) ctx.push(`A few individual videos from the source, for subject-matter flavor ONLY (these are separate videos — never name, quote, or treat any of them as the show's title or as a single episode):\n- ${body.sampleTitles.filter(Boolean).slice(0, 8).join('\n- ')}`)

  const SYSTEM =
    'You write the directory description for an AI-hosted podcast SHOW — an ongoing series, not a single ' +
    'episode. 2–3 sentences, roughly 45–70 words. Describe what the show is about in general: its recurring ' +
    'theme, its hosts, and the source channel it covers. Name the hosts. ' +
    'If a show title is given, that is the ONLY title for the show — never invent a different name, and never ' +
    'pull a name from the listed sample videos. The sample videos are just individual uploads from the source: ' +
    'use them only to gauge the general subject matter and vibe — never quote them, never name one, and never ' +
    'imply the show is called after one or recap one as if it happened in a single episode. ' +
    'Sound natural, warm, and inviting, like a real show blurb. Vary your phrasing. NEVER use the words ' +
    '"this episode", "in this episode", "today", or "this week". No quotes, hashtags, emojis, em dashes (—), ' +
    'markdown, or URLs. ' +
    'Do not begin with "Welcome to" or "This podcast". Output only the description.'

  try {
    const model = await getFastModel()
    const result = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: ctx.join('\n') },
    ], undefined, { temperature: 0.85, num_predict: 240 })
    // Belt-and-suspenders: scrub any em dashes / emoji the model slipped in anyway.
    const description = cleanAutoText(result.message.content.replace(/^["']+|["']+$/g, ''))
    if (description) return c.json({ description })
  } catch (err) {
    console.warn('[podcasts/describe] generation failed:', err)
  }
  return c.json({ error: 'Generation unavailable' }, 503)
})

// ── Show cover art ─────────────────────────────────────────────────────────────

// Save a cover image (PNG bytes in the raw request body). Owner/admin only.
podcastsRoute.put('/shows/:id/cover', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('id')

  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show) return c.json({ error: 'Not found' }, 404)
  if (show.ownerUserId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: 'Empty body' }, 400)
  if (bytes.byteLength > 5 * 1024 * 1024) return c.json({ error: 'Too large' }, 413)

  const [userRow] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, user.id))
  const absPath = await userPath(user.id, userRow?.firstName ?? 'user', 'podcasts', 'covers', `${showId}.png`)
  await writeFile(absPath, bytes)
  const relPath = await toRelativePath(absPath)

  await db.update(podcastShows).set({ coverRelPath: relPath }).where(eq(podcastShows.id, showId))
  return c.json({ ok: true })
})

// Serve a show's cover image. 404 when unset so the client renders a generated fallback.
podcastsRoute.get('/shows/:id/cover', async (c) => {
  const showId = c.req.param('id')
  const [show] = await db.select({ coverRelPath: podcastShows.coverRelPath, artworkUrl: podcastShows.artworkUrl })
    .from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show) return c.json({ error: 'No cover' }, 404)
  // RSS shows: no uploaded cover, but remote channel art — serve it through the disk-cached
  // image proxy so ShowCover/now-playing render unchanged and the CDN never sees the client.
  if (!show.coverRelPath && show.artworkUrl) {
    const img = await getOrFetchProxyImage(show.artworkUrl).catch(() => null)
    if (!img) return c.json({ error: 'No cover' }, 404)
    return new Response(new Uint8Array(img.data), {
      headers: { 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=86400' },
    })
  }
  if (!show.coverRelPath) return c.json({ error: 'No cover' }, 404)

  let absPath: string
  try { absPath = await resolveUserPath(show.coverRelPath) } catch { return c.json({ error: 'Missing' }, 404) }
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.json({ error: 'Missing' }, 404) }

  return new Response(createReadStream(absPath) as any, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
    },
  })
})

// ── Stinger (intro/outro music) ───────────────────────────────────────────────

// Serve the shared SoundFont the client-side stinger generator renders from.
// Downloads it lazily on first request so a fresh install "just works" with no
// manual setup step — and records it so boot reconcile keeps it repaired.
podcastsRoute.get('/soundfont', async (c) => {
  let absPath: string
  try { absPath = await ensureStingerSoundfont() } catch { return c.json({ error: 'SoundFont unavailable' }, 503) }
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.json({ error: 'Missing' }, 404) }

  return new Response(createReadStream(absPath) as any, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

// Save a show's intro + outro stinger clips (multipart: intro, outro = 24 kHz mono WAV).
// Owner/admin only. Mirrors the cover PUT.
podcastsRoute.put('/shows/:id/stinger', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('id')

  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show) return c.json({ error: 'Not found' }, 404)
  if (!canEditShow(show, user)) return c.json({ error: 'Forbidden' }, 403)

  const form = await c.req.formData()
  const intro = form.get('intro')
  const outro = form.get('outro')
  if (!(intro instanceof File) || !(outro instanceof File)) return c.json({ error: 'intro and outro required' }, 400)

  const introBytes = new Uint8Array(await intro.arrayBuffer())
  const outroBytes = new Uint8Array(await outro.arrayBuffer())
  const MAX = 10 * 1024 * 1024
  if (introBytes.byteLength === 0 || outroBytes.byteLength === 0) return c.json({ error: 'Empty body' }, 400)
  if (introBytes.byteLength > MAX || outroBytes.byteLength > MAX) return c.json({ error: 'Too large' }, 413)

  const [userRow] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, user.id))
  const fn = userRow?.firstName ?? 'user'
  const introAbs = await userPath(user.id, fn, 'podcasts', 'stingers', `${showId}-intro.wav`)
  const outroAbs = await userPath(user.id, fn, 'podcasts', 'stingers', `${showId}-outro.wav`)
  await writeFile(introAbs, introBytes)
  await writeFile(outroAbs, outroBytes)

  const stinger = { introRelPath: await toRelativePath(introAbs), outroRelPath: await toRelativePath(outroAbs) }
  await db.update(podcastShows).set({ stingerJson: JSON.stringify(stinger) }).where(eq(podcastShows.id, showId))
  return c.json({ ok: true })
})

// Serve a stored stinger clip for audition on the show detail page.
podcastsRoute.get('/shows/:id/stinger/:part', async (c) => {
  const showId = c.req.param('id')
  const part = c.req.param('part')
  if (part !== 'intro' && part !== 'outro') return c.json({ error: 'Bad part' }, 400)

  const [show] = await db.select({ stingerJson: podcastShows.stingerJson })
    .from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show?.stingerJson) return c.json({ error: 'No stinger' }, 404)

  let cfg: { introRelPath?: string; outroRelPath?: string }
  try { cfg = JSON.parse(show.stingerJson) } catch { return c.json({ error: 'No stinger' }, 404) }
  const rel = part === 'intro' ? cfg.introRelPath : cfg.outroRelPath
  if (!rel) return c.json({ error: 'No stinger' }, 404)

  let absPath: string
  try { absPath = await resolveUserPath(rel) } catch { return c.json({ error: 'Missing' }, 404) }
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.json({ error: 'Missing' }, 404) }

  return new Response(createReadStream(absPath) as any, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
    },
  })
})

// ── Episodes ─────────────────────────────────────────────────────────────────

// Episode detail incl. transcript (speaker names resolved from the show's hosts).
podcastsRoute.get('/episodes/:id', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')

  const [episode] = await db.select().from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const [show] = await db.select({ ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
    .from(podcastShows).where(eq(podcastShows.id, episode.showId))
  if (!show || !canSeeShow(show, user)) return c.json({ error: 'Not found' }, 404)

  // Resolve character ids → display names for the transcript.
  let transcript: { speaker: string; text: string }[] = []
  if (episode.scriptJson) {
    let turns: ScriptTurn[] = []
    try { turns = JSON.parse(episode.scriptJson) as ScriptTurn[] } catch { turns = [] }
    const ids = [...new Set(turns.map(t => t.host).filter(Boolean))]
    const rows = ids.length
      ? await db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, ids))
      : []
    const nameMap = new Map(rows.map(r => [r.id, r.name]))
    transcript = turns
      .filter(t => t.text?.trim())
      .map(t => ({ speaker: nameMap.get(t.host) ?? 'Host', text: t.text }))
  }

  const [watch] = await db.select().from(podcastWatchState)
    .where(and(eq(podcastWatchState.userId, user.id), eq(podcastWatchState.episodeId, episodeId)))

  const sources = await db
    .select({ sourceType: podcastEpisodeSources.sourceType, sourceId: podcastEpisodeSources.sourceId, title: podcastEpisodeSources.title })
    .from(podcastEpisodeSources)
    .where(eq(podcastEpisodeSources.episodeId, episodeId))

  return c.json({
    episode: {
      ...episode,
      chapters: safeParse(episode.chaptersJson, [] as unknown[]),
      transcript,
      watchState: watch ?? null,
      sources,
    },
  })
})

podcastsRoute.get('/shows/:id/episodes', async (c) => {
  const showId = c.req.param('id')
  const user = c.get('user')

  const [show] = await db.select({ ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
    .from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show || !canSeeShow(show, user)) return c.json({ error: 'Not found' }, 404)

  const episodes = await db.select()
    .from(podcastEpisodes)
    .where(eq(podcastEpisodes.showId, showId))
    .orderBy(desc(podcastEpisodes.publishedAt), desc(podcastEpisodes.createdAt))

  // Attach watch state + this user's offline-download state
  const epIds = episodes.map(e => e.id)
  const watchRows = epIds.length > 0
    ? await db.select().from(podcastWatchState)
        .where(and(eq(podcastWatchState.userId, user.id), inArray(podcastWatchState.episodeId, epIds)))
    : []
  const watchMap = new Map(watchRows.map(w => [w.episodeId, w]))
  const downloadMap = await userDownloadMap(user.id, epIds)

  return c.json({
    episodes: episodes.map(e => ({
      ...e,
      chapters: safeParse(e.chaptersJson, [] as unknown[]),
      watchState: watchMap.get(e.id) ?? null,
      download: downloadMap.get(e.id) ?? null,
    })),
  })
})

podcastsRoute.post('/shows/:id/generate', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('id')

  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show) return c.json({ error: 'Show not found' }, 404)
  if (!canEditShow(show, user)) return c.json({ error: 'Forbidden' }, 403)
  if (isRssShow(show)) return c.json({ error: 'Subscribed podcasts get episodes from their feed' }, 400)

  // Get user firstName for path resolution
  const [userRow] = await db.select({ firstName: users.firstName })
    .from(users).where(eq(users.id, user.id))

  const now = new Date()
  const episodeId = crypto.randomUUID()
  const title = `${show.name} — ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`

  await db.insert(podcastEpisodes).values({
    id: episodeId,
    showId,
    title,
    status: 'pending',
    createdAt: now,
  })

  const payload = JSON.stringify({
    showId,
    episodeId,
    userId: user.id,
    userFirstName: userRow?.firstName ?? 'user',
  })

  await db.insert(downloadJobs).values({
    id: crypto.randomUUID(),
    type: 'podcast-generate',
    refId: payload,
    domain: 'podcast',
    sizeClass: 'small',
    label: `Podcast: ${show.name}`,
    status: 'pending',
    priority: 50,
    attempts: 0,
    maxAttempts: 3,
    variantKey: null,
    lastError: null,
    nextEligibleAt: null,
    progress: null,
    createdAt: now,
    updatedAt: now,
  })

  return c.json({ episodeId, status: 'pending' })
})

// Re-run generation for an existing episode (clears its audio, re-queues the job).
podcastsRoute.post('/episodes/:id/regenerate', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')

  const [episode] = await db.select().from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, episode.showId))
  if (!show) return c.json({ error: 'Show not found' }, 404)
  if (show.ownerUserId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  if (isRssShow(show)) return c.json({ error: 'Subscribed episodes cannot be regenerated' }, 400)

  // Best-effort cleanup of the old audio file.
  if (episode.audioRelPath) {
    try { await unlink(await resolveUserPath(episode.audioRelPath)) } catch { /* gone already */ }
  }

  const [userRow] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, show.ownerUserId))
  const now = new Date()
  await db.update(podcastEpisodes).set({
    status: 'pending', audioRelPath: null, durationSec: null, chaptersJson: null, error: null, generatedAt: null,
  }).where(eq(podcastEpisodes.id, episodeId))

  await db.insert(downloadJobs).values({
    id: crypto.randomUUID(),
    type: 'podcast-generate',
    refId: JSON.stringify({ showId: show.id, episodeId, userId: show.ownerUserId, userFirstName: userRow?.firstName ?? 'user' }),
    domain: 'podcast', sizeClass: 'small', label: `Podcast: ${show.name}`,
    status: 'pending', priority: 50, attempts: 0, maxAttempts: 3,
    variantKey: null, lastError: null, nextEligibleAt: null, progress: null,
    createdAt: now, updatedAt: now,
  })

  return c.json({ ok: true, status: 'pending' })
})

// Delete an episode (and its audio file).
podcastsRoute.delete('/episodes/:id', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')

  const [episode] = await db.select().from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const [show] = await db.select({ ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
    .from(podcastShows).where(eq(podcastShows.id, episode.showId))
  if (show && show.ownerUserId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  // Deleting an RSS episode is futile — the next feed refresh re-inserts it. Remove the
  // download instead (the subscriptions API) or unsubscribe.
  if (show && isRssShow(show) && user.role !== 'admin') return c.json({ error: 'Episodes of subscribed podcasts are managed by their feed' }, 400)

  if (episode.audioRelPath) {
    try { await unlink(await resolveUserPath(episode.audioRelPath)) } catch { /* gone already */ }
  }
  await db.delete(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  return c.json({ ok: true })
})

// ── Episode file streaming ────────────────────────────────────────────────────

// Serve a local audio file with clamped Range support (seek without re-buffering).
// `pin` holds an in-flight read on a blob so GC can't unlink it mid-stream.
function streamLocalAudio(c: { req: { header(name: string): string | undefined } }, absPath: string, contentType: string, pin?: string | null): Response {
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return Response.json({ error: 'File missing' }, { status: 404 }) }

  const attach = (stream: ReturnType<typeof createReadStream>) => {
    if (pin) {
      acquireRead(pin)
      const release = () => releaseRead(pin)
      stream.once('close', release)
      stream.once('error', release)
    }
    return stream
  }

  // Only honor a well-formed bytes=start-end; clamp to file size and 416 on impossible
  // ranges (a malformed header otherwise yields NaN offsets and a broken 206).
  const rangeHeader = c.req.header('range')
  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (rangeMatch) {
    const size = stat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    return new Response(
      attach(createReadStream(absPath, { start, end })) as any,
      {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': contentType,
        },
      }
    )
  }

  return new Response(
    attach(createReadStream(absPath)) as any,
    { headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' } }
  )
}

// Three sources, one endpoint — so the player never cares where audio lives:
//   1. generated episode → per-user mp3 file (audioRelPath)
//   2. downloaded RSS episode → shared blob (assetId), read-pinned against GC
//   3. remote RSS episode → proxied enclosure with Range passthrough (CORS/mixed-content
//      safe, client IP never reaches the podcast CDN — same posture as YT/image proxies)
podcastsRoute.get('/episodes/:id/stream', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')

  const [episode] = await db.select({
    audioRelPath: podcastEpisodes.audioRelPath, status: podcastEpisodes.status, showId: podcastEpisodes.showId,
    assetId: podcastEpisodes.assetId, enclosureUrl: podcastEpisodes.enclosureUrl, enclosureType: podcastEpisodes.enclosureType,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))

  if (!episode) return c.json({ error: 'Not found' }, 404)
  const [show] = await db.select({ ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
    .from(podcastShows).where(eq(podcastShows.id, episode.showId))
  if (!show || !canSeeShow(show, user)) return c.json({ error: 'Not found' }, 404)

  // 1. Generated episode: per-user file.
  if (episode.audioRelPath) {
    let absPath: string
    try { absPath = await resolveUserPath(episode.audioRelPath) } catch { return c.json({ error: 'File missing' }, 404) }
    return streamLocalAudio(c, absPath, 'audio/mpeg')
  }

  // 2. Downloaded RSS episode: shared blob store.
  if (episode.assetId) {
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, episode.assetId))
    if (asset?.status === 'ready' && asset.blobHash) {
      const absPath = await blobAbsPath(asset.blobHash)
      return streamLocalAudio(c, absPath, formatContentType(asset.format), asset.blobHash)
    }
  }

  // 3. Remote RSS episode: proxy the enclosure, forwarding Range both ways. Some hosts
  // ignore Range and answer 200 — pass the status through verbatim; <audio> copes.
  if (episode.enclosureUrl) {
    const fwdHeaders: Record<string, string> = { 'User-Agent': 'LokiDoki/3.0 podcast', Accept: '*/*' }
    const range = c.req.header('range')
    if (range) fwdHeaders.Range = range
    let upstream: Response
    try {
      upstream = await safeFetch(episode.enclosureUrl, { headers: fwdHeaders }, { timeoutMs: 30_000, maxRedirects: 8 })
    } catch {
      return c.json({ error: 'Episode source is not responding' }, 502)
    }
    if (!upstream.ok && upstream.status !== 206) {
      upstream.body?.cancel().catch(() => {})
      return c.json({ error: `Episode source responded ${upstream.status}` }, 502)
    }
    const body = upstream.body
    if (body) c.req.raw.signal.addEventListener('abort', () => { body.cancel().catch(() => {}) }, { once: true })
    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? formatContentType(enclosureFormat(episode.enclosureType, episode.enclosureUrl)),
      'Cache-Control': 'no-store',
    }
    for (const h of ['content-length', 'content-range', 'accept-ranges'] as const) {
      const v = upstream.headers.get(h)
      if (v) headers[h] = v
    }
    return new Response(body, { status: upstream.status, headers })
  }

  return c.json({ error: 'Not ready' }, 404)
})

// ── Watch state ───────────────────────────────────────────────────────────────

podcastsRoute.post('/watch-state', async (c) => {
  const user = c.get('user')
  const { episodeId, positionSec, completed } = await c.req.json<{
    episodeId: string; positionSec?: number; completed?: boolean
  }>()
  if (!episodeId) return c.json({ error: 'episodeId required' }, 400)
  const access = await showAccessForEpisode(episodeId)
  if (!access || !canSeeShow(access, user)) return c.json({ error: 'Not found' }, 404)

  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(podcastWatchState).values({
    id,
    userId: user.id,
    episodeId,
    positionSec: positionSec ?? 0,
    completed: completed ?? false,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [podcastWatchState.userId, podcastWatchState.episodeId],
    set: {
      positionSec: positionSec ?? 0,
      completed: completed ?? false,
      updatedAt: now,
    },
  })

  return c.json({ ok: true })
})

// ── Suggestions ───────────────────────────────────────────────────────────────

// Built-in suggestion templates. These are offered to all users on first boot.
const SUGGESTION_TEMPLATES = [
  {
    templateKey: 'yt-daily-recap',
    title: 'YouTube Daily Recap',
    description: 'Quick summary of new uploads from your subscriptions.',
    style: 'recap',
    segments: [{ type: 'youtube', label: 'YouTube' }],
  },
  {
    templateKey: 'yt-indepth',
    title: 'YouTube In-Depth',
    description: 'Deep dive into recent uploads with analysis.',
    style: 'in-depth',
    segments: [{ type: 'youtube', label: 'YouTube' }],
  },
  {
    templateKey: 'morning-briefing',
    title: 'Morning Briefing',
    description: 'News, weather, and what happened on this day in history.',
    style: 'briefing',
    segments: [{ type: 'news', label: 'News' }, { type: 'weather', label: 'Weather' }, { type: 'onThisDay', label: 'On This Day' }],
  },
  {
    templateKey: 'sports-roundtable',
    title: 'Sports Roundtable',
    description: 'Latest scores and sports discussion.',
    style: 'roundtable',
    segments: [{ type: 'sports', label: 'Sports' }],
  },
]

podcastsRoute.get('/suggestions', async (c) => {
  const user = c.get('user')

  // Seed suggestions for this user if none exist yet
  const existing = await db.select({ templateKey: podcastSuggestions.templateKey })
    .from(podcastSuggestions)
    .where(eq(podcastSuggestions.userId, user.id))

  const existingKeys = new Set(existing.map(e => e.templateKey))
  const toInsert = SUGGESTION_TEMPLATES.filter(t => !existingKeys.has(t.templateKey))

  if (toInsert.length > 0) {
    await db.insert(podcastSuggestions).values(
      toInsert.map(t => ({
        id: crypto.randomUUID(),
        userId: user.id,
        templateKey: t.templateKey,
        title: t.title,
        description: t.description ?? null,
        style: t.style,
        segmentsJson: JSON.stringify(t.segments),
        status: 'pending' as const,
        createdAt: new Date(),
      }))
    ).onConflictDoNothing()
  }

  const suggestions = await db.select()
    .from(podcastSuggestions)
    .where(and(eq(podcastSuggestions.userId, user.id), eq(podcastSuggestions.status, 'pending')))
    .orderBy(podcastSuggestions.createdAt)

  return c.json({ suggestions: suggestions.map(s => ({ ...s, segments: safeParse(s.segmentsJson, [] as unknown[]) })) })
})

podcastsRoute.post('/suggestions/:id/accept', async (c) => {
  const user = c.get('user')
  const suggId = c.req.param('id')

  const [sugg] = await db.select().from(podcastSuggestions)
    .where(and(eq(podcastSuggestions.id, suggId), eq(podcastSuggestions.userId, user.id)))
  if (!sugg) return c.json({ error: 'Not found' }, 404)

  // Mark suggestion accepted
  await db.update(podcastSuggestions).set({ status: 'accepted' }).where(eq(podcastSuggestions.id, suggId))

  // Create a show from the template
  const showId = crypto.randomUUID()
  await db.insert(podcastShows).values({
    id: showId,
    ownerUserId: user.id,
    // LLM-suggested title — scrub em dashes & emoji like the other auto-built shows.
    name: cleanAutoTitle(sugg.title) || sugg.title,
    description: sugg.description ?? null,
    style: sugg.style as any,
    hostsJson: '[]',
    segmentsJson: sugg.segmentsJson,
    visibility: 'personal',
    source: 'suggested',
    createdAt: new Date(),
  })

  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
  return c.json({ show })
})

// ── Admin: script model ─────────────────────────────────────────────────────
// Which Ollama model writes episode scripts. Unset = follow the main chat model.

podcastsRoute.get('/admin/settings', async (c) => {
  const user = c.get('user')
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const scriptModel = ((await getAppSetting('podcast.script_model')) as string | null) ?? ''
  let installedModels: string[] = []
  try { installedModels = (await ollamaList()).map(m => m.name) } catch { /* Ollama unreachable — selector degrades to free text */ }
  // PodcastIndex keys are secrets — report configured-ness + a hint, never the values.
  const piKey = (await getAppSetting('podcast.podcastindex_key')) as string | null
  const piSecret = (await getAppSetting('podcast.podcastindex_secret')) as string | null
  return c.json({
    scriptModel, installedModels,
    podcastIndex: {
      configured: !!(piKey && piSecret),
      keyHint: piKey ? `…${piKey.slice(-4)}` : null,
    },
  })
})

podcastsRoute.put('/admin/settings', async (c) => {
  const user = c.get('user')
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const body = await c.req.json() as { scriptModel?: string | null; podcastIndexKey?: string | null; podcastIndexSecret?: string | null }
  if (body.scriptModel !== undefined) await setAppSetting('podcast.script_model', String(body.scriptModel ?? '').trim())
  // Empty string clears the keys (turns the provider off); undefined leaves them alone.
  if (body.podcastIndexKey !== undefined) await setAppSetting('podcast.podcastindex_key', String(body.podcastIndexKey ?? '').trim())
  if (body.podcastIndexSecret !== undefined) await setAppSetting('podcast.podcastindex_secret', String(body.podcastIndexSecret ?? '').trim())
  return c.json({ ok: true })
})

podcastsRoute.post('/suggestions/:id/dismiss', async (c) => {
  const user = c.get('user')
  const suggId = c.req.param('id')
  await db.update(podcastSuggestions)
    .set({ status: 'dismissed' })
    .where(and(eq(podcastSuggestions.id, suggId), eq(podcastSuggestions.userId, user.id)))
  return c.json({ ok: true })
})
