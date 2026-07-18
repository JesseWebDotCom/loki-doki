// Daily camera activity digest: one short natural-language paragraph summarizing a
// camera's events over a window ("3 deliveries, the usual school pickup, one unknown
// vehicle at 22:14"). The local answer to iOS 27's AI camera activity summaries.
// Cached per camera+window; computed on demand, never on the ingest hot path.

import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '@/db'
import { frigateEvents } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'

export interface CameraDigest {
  digest: string | null
  eventCount: number
  model: string | null
}

interface CacheEntry { key: string; value: CameraDigest; at: number }
const cache = new Map<string, CacheEntry>()
const TTL_MS = 10 * 60 * 1000

function fmtClock(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ap = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m}${ap}`
}

/**
 * Build (or return a cached) activity digest for one camera over the last `hours`.
 * `now` is passed in so the function is deterministic/testable.
 */
export async function buildCameraDigest(
  camera: string,
  opts: { hours?: number; now: number },
): Promise<CameraDigest> {
  const hours = opts.hours ?? 24
  const since = new Date(opts.now - hours * 3_600_000)
  const key = `${camera}:${hours}`

  const hit = cache.get(camera)
  if (hit && hit.key === key && opts.now - hit.at < TTL_MS) return hit.value

  const rows = await db
    .select({
      label: frigateEvents.label,
      subLabel: frigateEvents.subLabel,
      title: frigateEvents.title,
      description: frigateEvents.description,
      severity: frigateEvents.severity,
      createdAt: frigateEvents.createdAt,
    })
    .from(frigateEvents)
    .where(and(eq(frigateEvents.camera, camera), gte(frigateEvents.createdAt, since)))
    .orderBy(desc(frigateEvents.createdAt))
    .limit(120)

  if (rows.length === 0) {
    const value: CameraDigest = { digest: null, eventCount: 0, model: null }
    cache.set(camera, { key, value, at: opts.now })
    return value
  }

  const lines = rows.slice(0, 80).map((r) => {
    const t = fmtClock(r.createdAt instanceof Date ? r.createdAt.getTime() : (r.createdAt as unknown as number))
    const what = r.description?.trim() || r.title?.trim() || [r.label, r.subLabel].filter(Boolean).join(' ') || 'activity'
    const sev = r.severity && r.severity !== 'normal' ? ` [${r.severity}]` : ''
    return `- ${t}: ${what}${sev}`
  }).join('\n')

  const system =
    'You summarize a home security camera\'s activity for a family, in 1 to 2 short sentences. ' +
    'Group routine events ("3 deliveries", "the usual evening dog walks") and call out anything unusual with its time. ' +
    'Plain and calm, no alarmism, no invented details, no em dashes. Return only the summary.'

  let digest: string | null = null
  let model: string | null = null
  try {
    model = await getModel()
    const res = await ollamaChat(
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: `Camera "${camera}", last ${hours}h:\n${lines}` },
      ],
      [],
      { temperature: 0.3, num_predict: 160 },
    )
    digest = (res.message?.content ?? '').trim() || null
  } catch {
    digest = null
  }

  const value: CameraDigest = { digest, eventCount: rows.length, model }
  cache.set(camera, { key, value, at: opts.now })
  return value
}
