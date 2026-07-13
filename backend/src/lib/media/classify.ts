// Kid-safe media: topical classifier. Source platforms only flag what THEY consider adult
// (age-gates, NSFW tags, explicit-lyric marks); they miss anything merely ABOUT a mature
// topic — a video on drug use, a true-crime podcast, a violent gaming clip. This scores an
// item's text (title + description + channel) against the same 8 content dials a profile
// already uses, so a verdict compares directly against the profile ceiling.
//
// Text-only by design (no thumbnail vision this pass — see the plan). Cached per (source,id)
// in media_classification; a stored all-'off' row means "checked, clean". Background-warmed
// like ensureAdvisories; never sits on a request path. Fails open everywhere.

import { db } from '@/db'
import { mediaClassification } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import {
  DIAL_KEYS, CONTENT_CATEGORIES, dialLevelValue, dialsExceedCeiling, normalizeDials,
  type ContentDials, type DialKey,
} from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'

export interface ClassifyInput {
  source: string
  id: string
  title: string
  description?: string | null
  channel?: string | null
}

// ── Store ────────────────────────────────────────────────────────────────────────────

export async function getClassifications(source: string, ids: string[]): Promise<Map<string, ContentDials>> {
  const out = new Map<string, ContentDials>()
  if (!ids.length) return out
  const rows = await db.select({ itemId: mediaClassification.itemId, json: mediaClassification.categoriesJson })
    .from(mediaClassification)
    .where(and(eq(mediaClassification.source, source), inArray(mediaClassification.itemId, ids.slice(0, 500))))
  for (const r of rows) {
    try { out.set(r.itemId, normalizeDials(JSON.parse(r.json) as Partial<Record<DialKey, unknown>>)) }
    catch { /* skip malformed */ }
  }
  return out
}

async function upsertClassification(source: string, id: string, dials: ContentDials): Promise<void> {
  try {
    await db.insert(mediaClassification)
      .values({ source, itemId: id, categoriesJson: JSON.stringify(dials), createdAt: new Date() })
      .onConflictDoUpdate({
        target: [mediaClassification.source, mediaClassification.itemId],
        set: { categoriesJson: JSON.stringify(dials), createdAt: new Date() },
      })
  } catch (err) {
    logger.debug(`[classify] upsert failed for ${source}:${id}: ${String(err)}`)
  }
}

// ── LLM ──────────────────────────────────────────────────────────────────────────────

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(DIAL_KEYS.map((k) => [k, { type: 'integer', minimum: 0, maximum: 2 }])),
  required: DIAL_KEYS as unknown as string[],
} as const

const SYSTEM = [
  'You are a content-safety classifier for a family media server. Given a piece of media\'s',
  'title, channel, and description, rate how strongly it features each category below on a',
  '0-2 scale, judging the MEDIA\'S OWN CONTENT (what a child would see/hear), not the mere',
  'mention of a word. 0 = none/incidental, 1 = present/moderate, 2 = heavy/explicit.',
  'Be calibrated: ordinary kid/family/educational content is 0 across the board. Reserve 2',
  'for genuinely explicit or graphic material. Categories:',
  ...CONTENT_CATEGORIES.map((c) => `- ${c.key}: ${c.help}`),
  'Output JSON only, one integer per category.',
].join(' ')

/** Classify one item now (LLM), persist, and return the verdict dials. Cached: if a row
 *  already exists it is returned without an LLM call. */
export async function classify(input: ClassifyInput): Promise<ContentDials | null> {
  try {
    const existing = await getClassifications(input.source, [input.id])
    const cached = existing.get(input.id)
    if (cached) return cached

    const model = await getFastModel()
    const parts = [`Title: ${input.title}`]
    if (input.channel) parts.push(`Channel: ${input.channel}`)
    if (input.description) parts.push(`Description: ${input.description.slice(0, 1200)}`)
    const chat = await ollamaChat(
      model,
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: parts.join('\n') }],
      [], { temperature: 0, num_predict: 120 }, CLASSIFY_SCHEMA,
    )
    const raw = JSON.parse(chat.message?.content?.trim() || '{}') as Record<string, unknown>
    const dials = {} as ContentDials
    for (const k of DIAL_KEYS) {
      const n = typeof raw[k] === 'number' ? (raw[k] as number) : 0
      dials[k] = dialLevelValue(k, n)
    }
    await upsertClassification(input.source, input.id, dials)
    return dials
  } catch (err) {
    logger.debug(`[classify] failed for ${input.source}:${input.id}: ${String(err)}`)
    return null
  }
}

// Background fill: only items not already classified, bounded + deduped, fire-and-forget.
// Kicked from list filters so the "unknown" population shrinks with use.
const inFlight = new Set<string>()
export function ensureClassifications(items: ClassifyInput[]): void {
  void (async () => {
    try {
      if (!items.length) return
      const bySource = new Map<string, ClassifyInput[]>()
      for (const it of items) {
        const arr = bySource.get(it.source) ?? []
        arr.push(it); bySource.set(it.source, arr)
      }
      for (const [source, arr] of bySource) {
        const known = await getClassifications(source, arr.map((a) => a.id))
        const todo = arr.filter((a) => {
          const key = `${source}:${a.id}`
          return !known.has(a.id) && !inFlight.has(key)
        }).slice(0, 20)
        for (const t of todo) inFlight.add(`${source}:${t.id}`)
        for (const t of todo) {
          try { await classify(t) }
          finally { inFlight.delete(`${source}:${t.id}`) }
        }
      }
    } catch (err) {
      logger.debug(`[classify] ensureClassifications failed: ${String(err)}`)
    }
  })()
}

/** Should an item be hidden under a ceiling given its classifier verdict?
 *  A verdict that exceeds the ceiling in any category → block. No verdict yet (undefined)
 *  → block only when the policy blocks unknowns (kid tier); otherwise show while the
 *  background pass classifies it. */
export function classificationBlocks(
  ceiling: ContentDials, verdict: ContentDials | undefined, unknownBlocks: boolean,
): boolean {
  if (!verdict) return unknownBlocks
  return dialsExceedCeiling(verdict, ceiling)
}
