// Smart Titles: shared enrichment for any hub source whose native metadata has no real
// title, only a caption/description (currently TikTok; any future caption-only source can
// call the same ensureSmartTitle/stampSmartTitles). Mirrors youtube/summarize.ts's Smart
// Description pattern: a per-user opt-out preference (default on), a long-cached per-video
// AI result, and an instant heuristic fallback so a video is never stuck waiting on
// generation.
//
// Generation and display are deliberately split: `ensureSmartTitle` (generates + caches,
// ~1-3s LLM call) is only ever safe on a single-item request path (the watch page) or from a
// background warmer — never on a request path serving a whole grid. `stampSmartTitles`
// (grids: home, source pages, following feed) only ever PEEKS the cache — zero added
// latency, a video without a cached title yet just keeps its heuristic one until a
// background pass (see providers/tiktok.ts's warmSmartTitles) fills it in. Both paths honor
// the per-user preference at the point titles are handed to a viewer, not at generation time
// — the cache entry itself is shared across users (keyed only by source+id) since a caption
// distills to the same title for everyone; only whether a given viewer SEES it varies.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { cachedLookup, cachedLookupStale, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import type { VideoItem } from '@/lib/videos/types'

const PREF_KEY = 'videos.smart_titles'

/** Defaults on, matching Smart Description and the other "clean this up automatically"
 *  toggles (SponsorBlock skip, DeArrow) that already default on in this app. */
export async function isSmartTitlesEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PREF_KEY)))
    .limit(1)
  return row ? row.value !== 'false' : true
}

const SMART_TITLE_SYSTEM =
  'You write a short, punchy title (like a YouTube video title), given a video\'s caption. Some ' +
  'source platforms have no real title field — creators write the caption as a hook or question ' +
  'aimed at engagement, not a title. Distill the caption into a concise title, under 70 ' +
  'characters, describing what the video actually shows. Do not wrap it in quotation marks. Do ' +
  'not start with the platform name or the creator\'s name. Output only the title, nothing else.'

async function generate(caption: string, author: string | null): Promise<string | null> {
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: SMART_TITLE_SYSTEM },
    { role: 'user', content: author ? `Creator: ${author}\nCaption: ${caption}` : `Caption: ${caption}` },
  ], undefined, { temperature: 0.4, num_predict: 60 })
  const cleaned = result.message.content.trim().replace(/^["']|["']$/g, '')
  return cleaned || null
}

/** Instant fallback — first sentence, or a hard truncation, whichever is shorter. Used before
 *  the AI title is cached (first-ever view of a video) and whenever Smart Titles is off. */
export function heuristicTitle(caption: string): string {
  const firstSentence = caption.match(/^[^.!?\n]{1,90}[.!?]/)?.[0]?.trim()
  const base = firstSentence || caption
  return base.length > 80 ? `${base.slice(0, 77).trimEnd()}…` : base
}

const NS = 'videos:smart-title'
const key = (source: string, id: string) => `${source}:${id}`

/**
 * Generate + cache a Smart Title for (source, id) derived from `caption` if absent (30-day
 * cache — expensive to regenerate, never changes for a given caption). Unconditional: callers
 * decide whether generation should happen here (watch page: check isSmartTitlesEnabled first
 * so a user with the toggle off never pays for one; background warmers: just call it, since
 * generating doesn't mean every viewer sees it — stampSmartTitles decides that per viewer).
 */
export async function ensureSmartTitle(source: string, id: string, caption: string, author: string | null): Promise<string | null> {
  if (!caption.trim()) return null
  return cachedLookup(NS, key(source, id), THIRTY_DAYS_MS, () => generate(caption, author)).catch(() => null)
}

/** Read-only cache peek — never generates, so it's always safe on a request path serving many
 *  items at once. Returns null if nothing's cached yet (item keeps its heuristic title). */
export async function peekSmartTitle(source: string, id: string): Promise<string | null> {
  const cached = await cachedLookupStale<string | null>(NS, key(source, id))
  return cached.value ?? null
}

/** Grid stamping: swap in each item's cached Smart Title (if any), respecting the viewer's
 *  preference. A no-op source (no cached entry — everything except TikTok today) costs one
 *  cheap parallel cache read per item and leaves the item untouched. */
export async function stampSmartTitles(items: VideoItem[], userId: string): Promise<VideoItem[]> {
  if (items.length === 0 || !(await isSmartTitlesEnabled(userId))) return items
  return Promise.all(items.map(async (it) => {
    const smart = await peekSmartTitle(it.source, it.id)
    return smart ? { ...it, title: smart } : it
  }))
}
