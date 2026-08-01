// AI "TL;DR" summary for the News in-app reader's right-column panel. Two entry points:
// ensureFeedItemSummary (subscribed feed items - persisted in feed_items.ai_summary) and
// ensureUrlSummary (headline cards with no DB row - short-lived in-memory cache). Mirrors the
// model/prompt style of lib/youtube/summarize.ts and lib/bookmarks/ai.ts.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { feedItems } from '@/db/schema'
import { getFastModel } from '@/lib/models'
import { structuredCall } from '@/llm/structured'
import { stripHtml } from '@/lib/content/extract'
import { cachedExtractArticle } from '@/lib/content/extractCache'
import { ensureFullContent } from '@/lib/feeds/contentQuality'

const MAX_CHARS = 6000
const MIN_TEXT_CHARS = 200 // below this there's nothing worth summarizing (thin teaser, extraction failure)

export interface ArticleSummary {
  intro: string      // 1-2 short sentences
  bullets: string[]  // 3-5 key points, each one short line
}

async function summarizeText(title: string | null, text: string): Promise<ArticleSummary | null> {
  const model = await getFastModel()
  const out = await structuredCall<{ intro?: string; bullets?: string[] }>(
    model,
    `Title: ${title ?? ''}\n\nArticle:\n${text.slice(0, MAX_CHARS)}\n\n` +
      'Return JSON: { "intro": 1-2 short sentences giving the gist, "bullets": 3-5 short bullet points, ' +
      'each a single key fact (no sub-clauses, no "- " prefix) }.',
    'You summarize news articles as simply and scannably as possible. Dive straight into the substance - ' +
      'no meta openers like "This article...", "The article discusses...", or "In this piece...". ' +
      'Each bullet is one short, plain fact - not a full paragraph.',
  )
  const intro = String(out.intro ?? '').trim()
  const bullets = Array.isArray(out.bullets) ? out.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 5) : []
  if (!intro && bullets.length === 0) return null
  return { intro, bullets }
}

function serialize(s: ArticleSummary): string {
  return JSON.stringify(s)
}
function deserialize(raw: string): ArticleSummary | null {
  try {
    const parsed = JSON.parse(raw) as ArticleSummary
    return parsed.intro || parsed.bullets?.length ? parsed : null
  } catch { return null }
}

// ── Subscribed feed items (persisted cache) ─────────────────────────────────────────

const feedItemInFlight = new Map<string, Promise<ArticleSummary | null>>()

/** Cached AI summary for a feed item, generating + persisting one if absent. Takes the
 *  already-authorized row (the route validates visibility) rather than an id, so this stays
 *  independent of feeds.ts's auth/visibility logic. */
export function ensureFeedItemSummary(row: typeof feedItems.$inferSelect): Promise<ArticleSummary | null> {
  // Falls through to regenerate when aiSummary is set but fails to parse (e.g. a legacy
  // plain-string summary from before the intro+bullets format) rather than caching that
  // failure as "no summary" forever.
  if (row.aiSummary) {
    const cached = deserialize(row.aiSummary)
    if (cached) return Promise.resolve(cached)
  }
  const existing = feedItemInFlight.get(row.id)
  if (existing) return existing
  const p = generateFeedItemSummary(row).finally(() => feedItemInFlight.delete(row.id))
  feedItemInFlight.set(row.id, p)
  return p
}

async function generateFeedItemSummary(row: typeof feedItems.$inferSelect): Promise<ArticleSummary | null> {
  const full = await ensureFullContent(row)
  const text = full.contentHtml ? stripHtml(full.contentHtml) : null
  if (!text || text.length < MIN_TEXT_CHARS) return null

  const summary = await summarizeText(full.title ?? row.title, text)
  if (!summary) return null
  await db.update(feedItems).set({ aiSummary: serialize(summary) }).where(eq(feedItems.id, row.id))
  return summary
}

// ── Headline cards with no feed_items row (short-lived in-memory cache) ────────────────

const URL_CACHE_TTL_MS = 60 * 60 * 1000 // 1h - these are ephemeral aggregator headlines, not "yours"
const urlCache = new Map<string, { summary: ArticleSummary | null; expiresAt: number }>()
const urlInFlight = new Map<string, Promise<ArticleSummary | null>>()

export function ensureUrlSummary(url: string): Promise<ArticleSummary | null> {
  const cached = urlCache.get(url)
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.summary)
  const existing = urlInFlight.get(url)
  if (existing) return existing
  const p = generateUrlSummary(url).finally(() => urlInFlight.delete(url))
  urlInFlight.set(url, p)
  return p
}

async function generateUrlSummary(url: string): Promise<ArticleSummary | null> {
  let summary: ArticleSummary | null = null
  try {
    // Shared LRU with the /article endpoint, so a reader open + summary is one extraction.
    const a = await cachedExtractArticle(url)
    const text = a.contentHtml ? stripHtml(a.contentHtml) : null
    if (text && text.length >= MIN_TEXT_CHARS) summary = await summarizeText(a.title, text)
  } catch { /* leave summary null - extraction failed (paywall, bot-blocked, etc.) */ }
  urlCache.set(url, { summary, expiresAt: Date.now() + URL_CACHE_TTL_MS })
  return summary
}
