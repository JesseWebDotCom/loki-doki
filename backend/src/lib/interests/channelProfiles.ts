// Channel profiler: figures out what each subscribed channel really IS ("guitar
// instruction", "funny pranks") from its name + a sample of recent upload titles,
// via one fast-model LLM call per channel. The point is generalization: the
// sub-topic bucket in videos.ts searches these phrases broadly, so a guitar
// instruction subscription earns guitar videos from OTHER channels, not just that
// channel's own uploads. Everything reads from yt_videos rows the RSS poller
// already keeps fresh (no network besides the LLM), and profiles cache 30 days
// keyed on the sampled titles, so a channel whose content shifts re-profiles.

import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { ytSubscriptions, ytVideos } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

// Recent upload titles sampled per channel (the LLM sees these plus the name).
const SAMPLE_TITLES = 8
// Parallel LLM calls while batch-building a user's profiles.
const PROFILE_CONCURRENCY = 3
const CACHE_NS = 'yt-channel-profile'

/** What one subscribed channel is about. `what` is a 2-5 word description; `topics`
 *  are 1-3 broad YouTube search phrases for finding MORE of that kind of content. */
export interface ChannelProfile {
  channelId: string
  channelName: string
  what: string
  topics: string[]
}

/** One aggregated topic across the user's subscriptions, with the channels that
 *  earned it: "guitar lessons for beginners" backed by ["Marty Music", "JustinGuitar"]. */
export interface SubscriptionTopic {
  topic: string
  channels: string[]
}

const SYSTEM =
  'You are given a YouTube channel\'s name and the titles of its recent uploads. ' +
  'Determine what KIND of channel it is, then name broad YouTube search phrases someone ' +
  'would type to find more videos of that kind from OTHER channels. Respond with ONLY a ' +
  'JSON object {"what":"<2-5 word channel description>","topics":["<search phrase>"]} ' +
  'with 1 to 3 topics. Example: {"what":"guitar instruction","topics":["guitar lessons ' +
  'for beginners","blues guitar technique"]}. Topics must describe the kind of content, ' +
  'never repeat the channel name and never quote a specific video title. No prose, no ' +
  'code fences.'

/** Normalize one model-produced phrase; null for degenerate output. */
const cleanPhrase = (t: unknown): string | null => {
  if (typeof t !== 'string') return null
  const q = t.trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ')
  return q.length >= 3 && q.length <= 80 ? q : null
}

/** Pull the profile object out of a model reply, tolerating fences/prose around it.
 *  Null when unusable (cached too, so a dud channel isn't retried every build). */
function parseProfile(raw: string): { what: string; topics: string[] } | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { what?: unknown; topics?: unknown }
    const what = cleanPhrase(obj.what)
    const topics = Array.isArray(obj.topics)
      ? obj.topics.map(cleanPhrase).filter((t): t is string => t !== null).slice(0, 3)
      : []
    return what && topics.length ? { what, topics } : null
  } catch {
    return null
  }
}

/** Profile one channel via cachedLookup. The key hashes the sampled titles, so new
 *  uploads that change the sample trigger a re-profile even inside the TTL. LLM
 *  transport failures throw out of the fetcher (nothing cached, retried next build)
 *  and surface here as null; unusable model output caches as null. */
async function profileChannel(channelId: string, channelName: string, titles: string[]): Promise<ChannelProfile | null> {
  const sampleHash = createHash('sha256').update(titles.join('\n')).digest('hex').slice(0, 16)
  const cached = await cachedLookup<{ what: string; topics: string[] } | null>(
    CACHE_NS,
    `${channelId}:${sampleHash}`,
    THIRTY_DAYS_MS,
    async () => {
      const model = await getFastModel()
      const sample = [
        `Channel: ${channelName}`,
        titles.length ? `Recent uploads:\n${titles.map((t) => `- ${t}`).join('\n')}` : null,
      ].filter(Boolean).join('\n')
      const res = await ollamaChat(model, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: sample },
      ], undefined, { temperature: 0.2, num_predict: 160 })
      const profile = parseProfile(res.message.content)
      logger.info({ channelName, profile }, 'interests: channel profiled')
      return profile
    },
  ).catch(() => null)
  return cached ? { channelId, channelName, ...cached } : null
}

/** All profiles for a user's subscribed channels, built lazily with a small
 *  concurrency cap (cache hits are free; only new/shifted channels pay an LLM
 *  call). Channels the model can't profile are simply absent. Never throws. */
export async function buildChannelProfiles(userId: string): Promise<ChannelProfile[]> {
  try {
    const subs = await db
      .select({ id: ytSubscriptions.id, channelId: ytSubscriptions.externalId, title: ytSubscriptions.title })
      .from(ytSubscriptions)
      .where(and(eq(ytSubscriptions.userId, userId), eq(ytSubscriptions.kind, 'channel')))
    if (!subs.length) return []

    // Newest-first titles for all subscriptions in one query, grouped per channel.
    const rows = await db
      .select({ subId: ytVideos.subscriptionId, videoId: ytVideos.videoId, title: ytVideos.title })
      .from(ytVideos)
      .innerJoin(ytSubscriptions, eq(ytVideos.subscriptionId, ytSubscriptions.id))
      .where(and(eq(ytSubscriptions.userId, userId), eq(ytSubscriptions.kind, 'channel')))
      .orderBy(desc(ytVideos.publishedAt))
      .limit(2000)
    const titlesBySub = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.subId || !r.title || r.title === r.videoId) continue
      const list = titlesBySub.get(r.subId) ?? []
      if (list.length < SAMPLE_TITLES) {
        list.push(r.title)
        titlesBySub.set(r.subId, list)
      }
    }

    // Stable order in, sorted out: worker completion order varies, and downstream
    // aggregation must be deterministic.
    const queue = [...subs].sort((a, z) => a.channelId.localeCompare(z.channelId))
    const out: ChannelProfile[] = []
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(PROFILE_CONCURRENCY, queue.length) }, async () => {
        while (next < queue.length) {
          const s = queue[next++]!
          const p = await profileChannel(s.channelId, s.title || s.channelId, titlesBySub.get(s.id) ?? [])
          if (p) out.push(p)
        }
      }),
    )
    return out.sort((a, z) => a.channelId.localeCompare(z.channelId))
  } catch (err) {
    logger.warn(`[interests/channelProfiles] build failed: ${err}`)
    return []
  }
}

/** Deduped topics across the user's subscriptions, each with the channel names
 *  that share it, ranked by how many channels do (two prank channels make "funny
 *  pranks" a stronger interest than one). Deterministic; empty on any failure. */
export async function subscriptionTopics(userId: string): Promise<SubscriptionTopic[]> {
  const profiles = await buildChannelProfiles(userId)
  const byTopic = new Map<string, SubscriptionTopic>()
  for (const p of profiles) {
    for (const t of p.topics) {
      const key = t.trim().toLowerCase().replace(/\s+/g, ' ')
      const cur = byTopic.get(key) ?? { topic: t, channels: [] }
      if (!cur.channels.includes(p.channelName)) cur.channels.push(p.channelName)
      byTopic.set(key, cur)
    }
  }
  return [...byTopic.values()].sort(
    (a, z) => z.channels.length - a.channels.length || a.topic.localeCompare(z.topic),
  )
}
