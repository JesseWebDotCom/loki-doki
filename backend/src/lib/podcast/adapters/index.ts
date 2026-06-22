// Content adapters — each returns a SegmentContent for the given segment config.

import { db } from '@/db'
import { ytVideos, ytSubscriptions } from '@/db/schema'
import { eq, inArray, desc } from 'drizzle-orm'
import { getTranscriptText } from '@/lib/youtube/transcript'
import { summarizeVideo } from '../videoBrief'
import type { ShowSegment, SegmentContent } from '../types'

/** Total transcript budget across all selected videos, to keep the script prompt bounded. */
const TRANSCRIPT_BUDGET = 12_000

interface VideoRef { videoId: string; title?: string; author?: string }

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
      const transcript = await getTranscriptText(v.videoId, userId, userFirstName)
      if (!transcript) {
        items.push(`${heading}\n(No transcript available — discuss based on the title.)`)
        continue
      }
      // Prefer a structured third-person brief (overall premise + ordered arc) so the hosts
      // follow the big picture instead of re-enacting truncated first-person minutiae.
      const brief = await summarizeVideo(v.title ?? v.videoId, v.author, transcript, maxChunks)
      if (brief && (brief.premise || brief.beats.length)) {
        const arc = brief.beats.length
          ? `\nHow it unfolds, in order — build the discussion around this arc (set up the overview first, then walk each major part):\n${brief.beats.map(b => `- ${b}`).join('\n')}`
          : ''
        items.push(`${heading}\nWhat the video is about (overall): ${brief.premise}${arc}`)
      } else {
        // Summarizer unavailable — fall back to a labeled transcript excerpt (their words,
        // discuss in third person).
        items.push(`${heading}\nTranscript of ${who} speaking in the video (their words, NOT the hosts' — discuss it in the third person):\n${transcript.slice(0, perVideo)}`)
      }
    }
    const sources = explicit.map(v => ({ type: 'youtube' as const, id: v.videoId, title: v.title }))
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

async function weatherAdapter(_userId: string, params?: Record<string, unknown>): Promise<SegmentContent> {
  try {
    const lat = params?.lat as number | undefined
    const lng = params?.lng as number | undefined
    if (!lat || !lng) return { label: 'Weather', items: [] }
    const { weatherSummary } = await import('@/lib/briefing/sources/weather')
    const summary = await weatherSummary({ lat, lng, unit: 'fahrenheit' })
    return { label: 'Weather', items: summary ? [summary] : [] }
  } catch {
    return { label: 'Weather', items: [] }
  }
}

function customAdapter(_userId: string, params?: Record<string, unknown>): Promise<SegmentContent> {
  const text = (params?.text as string | undefined) ?? ''
  return Promise.resolve({ label: (params?.label as string | undefined) ?? 'Custom', items: text ? [text] : [] })
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
      default:          return { label: segment.label ?? segment.type, items: [] }
    }
  } catch {
    return { label: segment.label ?? segment.type, items: [] }
  }
}
