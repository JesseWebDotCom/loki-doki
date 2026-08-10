// Content adapters — each returns a SegmentContent for the given segment config.

import { db } from '@/db'
import { ytVideos, ytSubscriptions } from '@/db/schema'
import { eq, inArray, desc } from 'drizzle-orm'
import { resolveVideoTranscript } from '@/lib/podcast/transcript'
import { summarizeVideo } from '@/lib/videos/videoBrief'
import type { ShowSegment, SegmentContent, PodcastSourceType } from '../types'
import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { wikipediaSearch } from '@/lib/wikipediaSearch'

/** Total transcript budget across all selected videos, to keep the script prompt bounded. */
const TRANSCRIPT_BUDGET = 12_000

// ── Gap enrichment ─────────────────────────────────────────────────────────────────────
// Runs after summarizeVideo() to give hosts informed context about the creator and any
// terms/concepts in the brief that a general audience wouldn't know. The biggest gap in
// a raw transcript-to-podcast pipeline: hosts get a summary of words but no knowledge
// of WHO made it or WHY certain things matter.

interface KnowledgeGap { term: string; question: string; priority: number }

const GAP_SYSTEM =
  'You identify terms and references in a content brief that a general podcast audience ' +
  'would not recognize without explanation. For each, write the SPECIFIC question that ' +
  'would fill the gap (not a keyword restatement — a real question like "What is X and ' +
  'why does it matter in this context?"). Focus on: unexplained acronyms, named people or ' +
  'organizations without context, products/standards/concepts assumed as known, technical ' +
  'jargon. Ignore obvious everyday words. Return ONLY JSON: ' +
  '[{"term":"<term>","question":"<specific question>","priority":1-3}] ' +
  '(3=most critical to understanding; 1=nice-to-know). Return [] if nothing needs clarification.'

async function detectGaps(briefText: string): Promise<KnowledgeGap[]> {
  try {
    const model = await getFastModel()
    // Tight timeout: gap detection is best-effort enrichment. If Ollama is busy (e.g.
    // with generateCast/advanceBeats), skip it rather than queuing and delaying the main
    // script generation call which needs its own cold-model-load headroom.
    const resp = await ollamaChat(model, [
      { role: 'system', content: GAP_SYSTEM },
      { role: 'user', content: `Content brief:\n${briefText.slice(0, 3000)}` },
    ], undefined, { temperature: 0.3, num_predict: 400 }, undefined, 15_000)
    const arr = (resp.message?.content ?? '').match(/\[[\s\S]*\]/)?.[0]
    if (!arr) return []
    const parsed = JSON.parse(arr) as Record<string, unknown>[]
    return parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map(p => ({
        term: String(p.term ?? '').trim(),
        question: String(p.question ?? '').trim(),
        priority: typeof p.priority === 'number' ? p.priority : 1,
      }))
      .filter(p => p.term && p.question)
  } catch { return [] }
}

/**
 * Build a "Background context" block to append to the content item so the script model's
 * hosts can discuss the video as informed commentators rather than people who only read
 * a summary. Runs two enrichments in parallel: creator context + gap-identified terms.
 * Best-effort — returns '' on total failure.
 */
async function buildEnrichmentBlock(
  title: string,
  author: string | undefined,
  brief: { premise: string; beats: { point: string; details: string[] }[] },
): Promise<string> {
  const briefText = [brief.premise, ...brief.beats.slice(0, 5).map(b => b.point)].join('\n')

  // Run creator lookup + gap detection in parallel
  const [creatorResults, gaps] = await Promise.all([
    author ? wikipediaSearch(`${author} YouTube channel`, 1, 5000).catch(() => []) : Promise.resolve([]),
    detectGaps(briefText),
  ])

  // Deduplicate gaps by term (case-insensitive) and keep priority 2+ first
  const seen = new Set<string>()
  const topGaps = gaps
    .sort((a, b) => b.priority - a.priority)
    .filter(g => { const k = g.term.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, 4)

  // Run Wikipedia lookups for all gaps in parallel
  const gapResults = await Promise.all(
    topGaps.map(g =>
      wikipediaSearch(`${g.term} ${g.question}`, 1, 4000)
        .then(r => ({ term: g.term, snippet: r[0]?.snippet ?? '' }))
        .catch(() => ({ term: g.term, snippet: '' })),
    ),
  )

  const blocks: string[] = []

  if (creatorResults[0]?.snippet) {
    blocks.push(`About ${author} (the creator): ${creatorResults[0].snippet.slice(0, 200)}`)
  }

  for (const { term, snippet } of gapResults) {
    if (snippet) blocks.push(`${term}: ${snippet.slice(0, 150)}`)
  }

  if (!blocks.length) return ''
  return `\nBackground context (for hosts' informed commentary — weave this in naturally):\n${blocks.map(b => `- ${b}`).join('\n')}`
}

// `source` + `url` let non-YouTube videos (TikTok/Vimeo/Reddit/link) resolve a transcript
// from their page URL; both are absent for plain YouTube refs (source defaults to youtube).
interface VideoRef { videoId: string; title?: string; author?: string; source?: string; url?: string }

async function youtubeAdapter(
  userId: string,
  userFirstName: string,
  params?: Record<string, unknown>,
): Promise<SegmentContent> {
  // Explicit videos (from "make podcast from this video / selection / channel") →
  // pull each video's full transcript so the hosts discuss the actual content.
  // Cap the number of videos so "make a podcast from this channel" (which can pass
  // hundreds) can't fan out into hundreds of sequential transcript fetches per job.
  const MAX_EXPLICIT_VIDEOS = 20
  const explicit = (params?.videos as VideoRef[] | undefined)?.filter(v => v?.videoId).slice(0, MAX_EXPLICIT_VIDEOS)
  if (explicit?.length) {
    const perVideo = Math.max(1_500, Math.floor(TRANSCRIPT_BUDGET / explicit.length))
    // A single-video episode covers the whole transcript in depth; many videos at once
    // get coarser chunking so the job doesn't fan out into hundreds of summarizer calls.
    const maxChunks = explicit.length <= 2 ? 6 : explicit.length <= 6 ? 3 : 1
    const items: string[] = []
    for (const v of explicit) {
      const who = v.author ?? 'the creator'
      const heading = v.author ? `Video: "${v.title ?? v.videoId}" — created by ${v.author}` : `Video: "${v.title ?? v.videoId}"`
      const transcript = await resolveVideoTranscript(v, userId, userFirstName)
      if (!transcript) {
        items.push(`${heading}\n(No transcript available — discuss based on the title.)`)
        continue
      }
      // Prefer a structured third-person brief (overall premise + ordered arc) so the hosts
      // follow the big picture instead of re-enacting truncated first-person minutiae.
      const brief = await summarizeVideo(v.title ?? v.videoId, v.author, transcript, maxChunks)
      if (brief && (brief.premise || brief.beats.length)) {
        // Each beat carries its concrete specifics as sub-bullets — this is the material
        // the hosts actually discuss, so keep the detail, not just the arc headings.
        const arc = brief.beats.length
          ? `\nHow it unfolds, in order — build the discussion around this arc (set up the overview first, then walk each major part):\n${brief.beats.map(b =>
              `- ${b.point}${b.details.length ? `\n${b.details.map(d => `    · ${d}`).join('\n')}` : ''}`,
            ).join('\n')}`
          : ''
        const enrichment = await buildEnrichmentBlock(v.title ?? v.videoId, v.author, brief).catch(() => '')
        items.push(`${heading}\nWhat the video is about (overall): ${brief.premise}${arc}${enrichment}`)
      } else {
        // Summarizer unavailable — fall back to a labeled transcript excerpt (their words,
        // discuss in third person).
        items.push(`${heading}\nTranscript of ${who} speaking in the video (their words, NOT the hosts' — discuss it in the third person):\n${transcript.slice(0, perVideo)}`)
      }
    }
    const sources = explicit.map(v => ({ type: (v.source ?? 'youtube') as PodcastSourceType, id: v.videoId, title: v.title }))
    return { label: 'YouTube', items, sources }
  }

  // Default: recent videos across the user's subscriptions, using cached summaries.
  const limit = (params?.limit as number | undefined) ?? 10
  const subs = await db.select({ id: ytSubscriptions.id })
    .from(ytSubscriptions)
    .where(eq(ytSubscriptions.userId, userId))

  const subIds = subs.map(s => s.id)
  const videos = subIds.length > 0
    ? await db.select({ videoId: ytVideos.videoId, title: ytVideos.title, author: ytVideos.author, summary: ytVideos.summary })
        .from(ytVideos)
        .where(inArray(ytVideos.subscriptionId, subIds))
        .orderBy(desc(ytVideos.publishedAt))
        .limit(limit)
    : []

  const items = videos.map(v =>
    v.summary ? `${v.title} (${v.author}): ${v.summary.slice(0, 200)}` : `${v.title} by ${v.author}`
  )
  const sources = videos.map(v => ({ type: 'youtube' as const, id: v.videoId, title: v.title }))

  return { label: 'YouTube', items, sources }
}

async function newsAdapter(_userId: string, _params?: Record<string, unknown>): Promise<SegmentContent> {
  try {
    const { worldNews } = await import('@/lib/briefing/sources/worldNews')
    const articles = await worldNews(8)
    return { label: 'News', items: articles.map(a => `${a.title}: ${a.summary ?? ''}`.trim()) }
  } catch {
    return { label: 'News', items: [] }
  }
}

async function sportsAdapter(_userId: string, _params?: Record<string, unknown>): Promise<SegmentContent> {
  try {
    const { sportsToday } = await import('@/lib/briefing/sources/sports')
    const scores = await sportsToday()
    return { label: 'Sports', items: scores.map(s => s.summary ?? s.title ?? '') }
  } catch {
    return { label: 'Sports', items: [] }
  }
}

async function onThisDayAdapter(_userId: string, _params?: Record<string, unknown>): Promise<SegmentContent> {
  try {
    const { onThisDay } = await import('@/lib/briefing/sources/onThisDay')
    const events = await onThisDay()
    return { label: 'On This Day', items: events.slice(0, 5).map(e => e.summary ?? e.title ?? '') }
  } catch {
    return { label: 'On This Day', items: [] }
  }
}

async function weatherAdapter(userId: string, params?: Record<string, unknown>): Promise<SegmentContent> {
  try {
    let lat = params?.lat as number | undefined
    let lng = params?.lng as number | undefined
    let locationName: string | undefined
    if (!lat || !lng) {
      // No explicit coordinates on the segment: fall back to the show owner's saved
      // location (the same 'user.location' preference the briefing system uses), so a
      // weather segment works out of the box for preset-created shows.
      const { userPreferences } = await import('@/db/schema')
      const { and: andOp } = await import('drizzle-orm')
      const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
        .where(andOp(eq(userPreferences.userId, userId), eq(userPreferences.key, 'user.location')))
        .limit(1)
      if (row?.value) {
        try {
          const loc = JSON.parse(row.value) as { displayName?: string; lat?: number; lng?: number }
          lat = loc.lat; lng = loc.lng; locationName = loc.displayName
        } catch { /* malformed pref */ }
      }
    }
    if (!lat || !lng) return { label: 'Weather', items: [] }
    const { weatherSummary } = await import('@/lib/briefing/sources/weather')
    const summary = await weatherSummary({ location: locationName, lat, lng, unit: 'fahrenheit' })
    return { label: 'Weather', items: summary ? [summary] : [] }
  } catch {
    return { label: 'Weather', items: [] }
  }
}

function customAdapter(_userId: string, params?: Record<string, unknown>): Promise<SegmentContent> {
  const text = (params?.text as string | undefined) ?? ''
  return Promise.resolve({ label: (params?.label as string | undefined) ?? 'Custom', items: text ? [text] : [] })
}

// One TV episode → discussion material. The hosts recap/react to THIS episode; the synopsis
// is supplied by the queueing route (TVMaze), and we enrich with a best-effort Wikipedia
// lookup for the episode/season so the hosts have more than a one-line logline to chew on.
async function tvshowAdapter(params?: Record<string, unknown>): Promise<SegmentContent> {
  const showName = String(params?.showName ?? '')
  const episodeName = String(params?.episodeName ?? '')
  const season = params?.season != null ? Number(params.season) : null
  const number = params?.number != null ? Number(params.number) : null
  const synopsis = String(params?.synopsis ?? '')
  const genres = Array.isArray(params?.genres) ? (params!.genres as string[]) : []

  const code = season != null ? `Season ${season}${number != null ? `, Episode ${number}` : ''}` : ''
  const heading = `${showName} — "${episodeName}"${code ? ` (${code})` : ''}`

  const items: string[] = []
  items.push(
    `This episode of ${showName}${genres.length ? ` (a ${genres.join('/')} series)` : ''}: ${heading}.` +
      (synopsis ? `\nWhat happens: ${synopsis}` : '\n(No official synopsis available — discuss based on the title and what is known.)'),
  )

  // Best-effort encyclopedic enrichment (plot detail, production notes, reception).
  try {
    const { wikipediaSearch } = await import('@/lib/wikipediaSearch')
    const wiki = await wikipediaSearch(`${showName} ${episodeName} episode`, 1)
    if (wiki[0]?.snippet) items.push(`Background (Wikipedia): ${wiki[0].snippet.slice(0, 600)}`)
  } catch {
    /* enrichment is optional */
  }

  return { label: showName || 'TV Episode', items }
}

// One movie → a single deep-dive discussion. Pulls the plot/overview + reception from
// Wikipedia and web search so the hosts can talk through the film as commentators.
async function movieAdapter(params?: Record<string, unknown>): Promise<SegmentContent> {
  const title = String(params?.title ?? '')
  const year = params?.year != null ? Number(params.year) : null
  const overview = String(params?.overview ?? '')

  const items: string[] = []
  if (overview) items.push(`${title}${year ? ` (${year})` : ''}: ${overview}`)

  try {
    const { wikipediaSearch } = await import('@/lib/wikipediaSearch')
    const wiki = await wikipediaSearch(`${title} ${year ?? ''} film`, 1)
    if (wiki[0]?.snippet) items.push(`Overview & plot (Wikipedia): ${wiki[0].snippet.slice(0, 900)}`)
  } catch {
    /* optional */
  }
  try {
    const { getReviews } = await import('@/lib/titles/reviews')
    const reviews = await getReviews(title, year ? String(year) : null, 'movie')
    if (reviews?.summary) items.push(`Critical & audience reception: ${reviews.summary}`)
  } catch {
    /* optional */
  }

  if (!items.length) items.push(`${title}${year ? ` (${year})` : ''} — discuss the film based on what is known.`)
  return { label: title || 'Movie', items }
}

// ── Bookmarks / "Your Reading Week" ────────────────────────────────────────────
// Recaps the articles the user saved recently (params.days window, default 7) so a show
// can carry a weekly reading-digest segment. Excerpts are often the AI TL;DR persisted
// by the bookmarks summarize action; falls back to the article head.
async function bookmarksAdapter(userId: string, userFirstName: string, params?: Record<string, unknown>): Promise<SegmentContent> {
  const { db: database } = await import('@/db')
  const { bookmarks } = await import('@/db/schema')
  const { and, desc, eq, gt, isNull, or } = await import('drizzle-orm')
  const days = Math.max(1, Math.min(31, Number(params?.days) || 7))
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const rows = await database.select().from(bookmarks)
    .where(and(
      or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, userId)),
      eq(bookmarks.type, 'offline'),
      gt(bookmarks.createdAt, cutoff),
    ))
    .orderBy(desc(bookmarks.createdAt))
    .limit(8)
  const items = rows.map((r) => {
    const gist = r.excerpt?.trim() || r.contentText?.slice(0, 400)?.trim() || ''
    return `${r.title}${r.siteName ? ` (${r.siteName}${r.readingMins ? `, ${r.readingMins} min` : ''})` : ''}${gist ? `: ${gist}` : ''}`
  })
  if (items.length) {
    items.unshift(`Articles ${userFirstName} saved over the last ${days === 7 ? 'week' : `${days} days`} — recap each briefly and call out which are most worth reading first.`)
  }
  return { label: 'Your Reading Week', items }
}

// ── Household / "Around the House" ─────────────────────────────────────────────
// Today's household happenings for a private family morning show: upcoming profile
// birthdays (users.birthdate) and recently updated household-shared notes (the family
// board). These are the two household data sources that actually exist server-side;
// there is no calendar or reminders subsystem to pull from.
async function householdAdapter(_userId: string, _userFirstName: string, params?: Record<string, unknown>): Promise<SegmentContent> {
  const label = 'Around the House'
  const items: string[] = []
  const now = new Date()

  // Upcoming birthdays within the window (default 14 days), soonest first.
  try {
    const { users: usersTable } = await import('@/db/schema')
    const windowDays = Math.max(1, Math.min(60, Number(params?.birthdayDays) || 14))
    const people = await db.select({
      firstName: usersTable.firstName, nickname: usersTable.nickname, birthdate: usersTable.birthdate,
    }).from(usersTable)
    const upcoming: Array<{ name: string; when: Date; turning: number | null; daysAway: number }> = []
    for (const p of people) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.birthdate ?? '')
      if (!m) continue
      const [, y, mo, d] = m
      let next = new Date(now.getFullYear(), Number(mo) - 1, Number(d))
      next.setHours(12, 0, 0, 0)
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
      if (next < today) next = new Date(now.getFullYear() + 1, Number(mo) - 1, Number(d), 12)
      const daysAway = Math.round((next.getTime() - today.getTime()) / 86_400_000)
      if (daysAway > windowDays) continue
      const birthYear = Number(y)
      const turning = birthYear > 1900 ? next.getFullYear() - birthYear : null
      upcoming.push({ name: p.nickname || p.firstName, when: next, turning, daysAway })
    }
    upcoming.sort((a, b) => a.daysAway - b.daysAway)
    for (const b of upcoming.slice(0, 4)) {
      const whenText = b.daysAway === 0 ? 'TODAY'
        : b.daysAway === 1 ? 'tomorrow'
        : `on ${b.when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} (${b.daysAway} days away)`
      items.push(`Birthday: ${b.name}'s birthday is ${whenText}${b.turning ? `, turning ${b.turning}` : ''}. ${b.daysAway === 0 ? 'Make a big deal of it on the show!' : 'Worth a mention so nobody forgets.'}`)
    }
  } catch { /* best-effort */ }

  // Household-shared notes: pinned board notes plus anything updated recently.
  try {
    const { notes } = await import('@/db/schema')
    const { and: andOp, desc: descOp, gt, isNull, or: orOp } = await import('drizzle-orm')
    const days = Math.max(1, Math.min(31, Number(params?.noteDays) || 3))
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const rows = await db.select({
      title: notes.title, body: notes.body, pinned: notes.pinned, updatedAt: notes.updatedAt,
    }).from(notes)
      .where(andOp(isNull(notes.ownerId), orOp(eq(notes.pinned, true), gt(notes.updatedAt, cutoff))))
      .orderBy(descOp(notes.pinned), descOp(notes.updatedAt))
      .limit(6)
    for (const n of rows) {
      const gist = n.body.replace(/[#*`>\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
      const title = n.title.trim() || 'Untitled note'
      items.push(`${n.pinned ? 'Pinned family note' : 'Family note'} "${title}"${gist ? `: ${gist}` : ''}`)
    }
  } catch { /* best-effort */ }

  if (items.length) {
    items.unshift(
      `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}. ` +
      'These are this household\'s own updates (family notes and birthdays). Chat through them warmly, like a neighborhood bulletin, and keep names exactly as given.',
    )
  }
  return { label, items }
}

export async function runAdapter(segment: ShowSegment, userId: string, userFirstName: string): Promise<SegmentContent> {
  try {
    switch (segment.type) {
      case 'youtube':   return await youtubeAdapter(userId, userFirstName, segment.params)
      case 'news':      return await newsAdapter(userId, segment.params)
      case 'sports':    return await sportsAdapter(userId, segment.params)
      case 'onThisDay': return await onThisDayAdapter(userId, segment.params)
      case 'weather':   return await weatherAdapter(userId, segment.params)
      case 'custom':    return await customAdapter(userId, segment.params)
      case 'tvshow':    return await tvshowAdapter(segment.params)
      case 'movie':     return await movieAdapter(segment.params)
      case 'bookmarks': return await bookmarksAdapter(userId, userFirstName, segment.params)
      case 'household': return await householdAdapter(userId, userFirstName, segment.params)
      default:          return { label: segment.label ?? segment.type, items: [] }
    }
  } catch {
    return { label: segment.label ?? segment.type, items: [] }
  }
}
