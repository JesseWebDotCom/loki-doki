// Music Insights — the companion answers questions about YOUR listening history.
//
// "When did I first listen to this?", "how many times have I played it?", "what have
// I been into lately?", "what artists have I been listening to?" — all answered from
// the local music_history table (no network). Genre data isn't recorded per play, so
// "what genres lately" is answered as a top-artists / top-songs summary rather than a
// fabricated genre breakdown. Returns structured data + a synthesisHint so the
// companion phrases the answer in-character.

import type { Tool, ToolResult } from './index'
import { db } from '@/db'
import { musicHistory } from '@/db/schema'
import { eq, and, gte, asc } from 'drizzle-orm'

type Intent = 'first_listen' | 'play_count' | 'recent' | 'top_artists'

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

function classifyInsight(q: string): Intent {
  const s = q.toLowerCase()
  if (/how many times|how often|how much have i (?:played|listened|heard)|play count/.test(s)) return 'play_count'
  if (/first (?:listen|hear|heard|play|time)|when did i (?:first )?(?:listen|hear|play)/.test(s)) return 'first_listen'
  if (/genre|artist|band|kind of music|been into|who have i been/.test(s)) return 'top_artists'
  return 'recent'
}

// Strip the question scaffolding to recover the song/artist the user named.
function extractSubject(q: string): string {
  return q
    .replace(/^\s*(?:hey\s+)?(?:so\s+)?(?:when did|how many times have|how often have|how often do|how much have)\s+i\s+(?:ever\s+)?(?:first\s+)?(?:listen(?:ed)? to|hear[d]?|play(?:ed)?)\s+/i, '')
    .replace(/\?+$/, '')
    .replace(/\b(?:the song|this song|that song|the track|this track|this one|that one)\b/gi, '')
    .replace(/\s+/g, ' ').trim()
}

function matches(row: { title: string; artist: string | null }, subject: string): boolean {
  const s = norm(subject)
  if (!s) return false
  const t = norm(row.title)
  const ar = norm(row.artist ?? '')
  if (t && (s.includes(t) || t.includes(s))) return true
  if (ar && s.includes(ar) && ar.length >= 3) return true
  return false
}

function daysAgo(d: Date): number {
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86_400_000))
}

export const musicInsightsTool: Tool = {
  id: 'music_insights',
  name: 'Music Insights',
  description: "Answer questions about the user's own listening history: first-listen dates, play counts, what they've been into lately, and their top artists",
  offline: true,
  passMessage: 'query',
  dataSources: [],
  examples: [
    'when did I first listen to Bohemian Rhapsody',
    'when did I first hear this song',
    'how many times have I played this',
    'how often do I listen to Taylor Swift',
    'what have I been listening to lately',
    'what artists have I been into recently',
    'what genres have I been into lately',
    'what have I been playing this week',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'music_insights',
      description:
        "Answer a question about the USER'S OWN listening history from their play data: when they first listened to a song, how many times they've played it, what they've been listening to lately, or their top artists. Not for playing music (that's play_music).",
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The listening-history question, e.g. "when did I first hear this" or "what have I been into lately"' },
          intent: {
            type: 'string',
            enum: ['first_listen', 'play_count', 'recent', 'top_artists'],
            description: 'first_listen: earliest play of a named song; play_count: how many times played; recent: recently played; top_artists: most-played artists',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const a = (args ?? {}) as { query?: string; intent?: string }
    const userId = config?.['_userId'] as string | undefined
    const raw = (a.query ?? (config?.['_rawMessage'] as string | undefined) ?? '').trim()
    if (!userId) return { success: false, error: 'No user in context' }

    const intent: Intent = a.intent && ['first_listen', 'play_count', 'recent', 'top_artists'].includes(a.intent)
      ? (a.intent as Intent)
      : classifyInsight(raw)

    try {
      // ── first_listen / play_count: need a named song (or "this" → most recent play) ──
      if (intent === 'first_listen' || intent === 'play_count') {
        const subject = extractSubject(raw)
        const rows = await db.select().from(musicHistory)
          .where(eq(musicHistory.userId, userId)).orderBy(asc(musicHistory.playedAt))
        if (!rows.length) {
          return { success: true, synthesisHint: `[No history]: They have no listening history yet. Say so warmly.` }
        }
        // "this song" with no name → the most recently played track.
        const hasName = norm(subject).length > 0
        const target = hasName ? rows.find(r => matches(r, subject)) : rows[rows.length - 1]
        const pool = hasName ? rows.filter(r => matches(r, subject)) : rows.filter(r => matches(r, `${rows[rows.length - 1]!.title} ${rows[rows.length - 1]!.artist ?? ''}`))
        if (!target) {
          return { success: true, data: { intent, subject }, synthesisHint: `[Not found]: They haven't played "${subject}" (that you have on record). Say so briefly.` }
        }
        const first = pool[0]!
        const plays = pool.length
        const label = first.artist ? `"${first.title}" by ${first.artist}` : `"${first.title}"`
        if (intent === 'play_count') {
          return {
            success: true,
            data: { intent, song: first.title, artist: first.artist, plays },
            synthesisHint: `[Play count]: They've played ${label} ${plays} time${plays === 1 ? '' : 's'}. Tell them in one natural line.`,
          }
        }
        const d = daysAgo(first.playedAt)
        return {
          success: true,
          data: { intent, song: first.title, artist: first.artist, firstPlayedAt: first.playedAt.toISOString(), daysAgo: d, plays },
          synthesisHint:
            `[First listen]: They first played ${label} ${d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`} ` +
            `(${first.playedAt.toISOString().slice(0, 10)}), and have played it ${plays} time${plays === 1 ? '' : 's'} total. One warm, natural line.`,
        }
      }

      // ── recent / top_artists: aggregate the last ~30 days (fall back to all-time) ──
      const since = new Date(Date.now() - 30 * 86_400_000)
      let rows = await db.select().from(musicHistory)
        .where(and(eq(musicHistory.userId, userId), gte(musicHistory.playedAt, since)))
        .orderBy(asc(musicHistory.playedAt))
      let windowLabel = 'the last month'
      if (rows.length < 5) {
        rows = await db.select().from(musicHistory).where(eq(musicHistory.userId, userId)).orderBy(asc(musicHistory.playedAt))
        windowLabel = 'their history'
      }
      if (!rows.length) {
        return { success: true, synthesisHint: `[No history]: They have no listening history yet. Say so warmly and offer to start a station.` }
      }

      if (intent === 'top_artists') {
        const counts = new Map<string, number>()
        for (const r of rows) {
          const ar = (r.artist ?? '').trim()
          if (ar) counts.set(ar, (counts.get(ar) ?? 0) + 1)
        }
        const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([artist, plays]) => ({ artist, plays }))
        const genreAsked = /genre|kind of music/i.test(raw)
        return {
          success: true,
          data: { intent, window: windowLabel, topArtists: top },
          synthesisHint: top.length
            ? `[Top artists]: Over ${windowLabel} their most-played artists are: ${top.map(t => `${t.artist} (${t.plays})`).join(', ')}. ` +
              `${genreAsked ? "You don't track genres per play, so answer with these artists as the read on their taste. " : ''}Give a short, natural summary — name the top 2-3.`
            : `[No artists]: Their recent plays have no artist tags. Say so briefly.`,
        }
      }

      // recent: distinct recently-played tracks, newest first
      const seen = new Set<string>()
      const recent: Array<{ title: string; artist: string | null }> = []
      for (let i = rows.length - 1; i >= 0 && recent.length < 10; i--) {
        const r = rows[i]!
        const key = `${norm(r.title)}|${norm(r.artist ?? '')}`
        if (seen.has(key)) continue
        seen.add(key)
        recent.push({ title: r.title, artist: r.artist })
      }
      return {
        success: true,
        data: { intent, window: windowLabel, recent },
        synthesisHint:
          `[Recently played]: Over ${windowLabel} they've been listening to: ` +
          `${recent.map(r => (r.artist ? `${r.title} — ${r.artist}` : r.title)).join('; ')}. ` +
          `Give a short, natural recap — highlight a few, don't list all ten.`,
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
