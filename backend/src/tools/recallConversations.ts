// recall_conversations — search the user's OWN past chats (raw messages +
// episode summaries) by keywords and/or timeframe. The Claude-memory pattern:
// tool-based search over raw history, because "what did we talk about on
// Sunday?" needs dates and verbatim text, which cosine recall over facts cannot
// answer. Strictly scoped to the asking user's conversations.

import { and, desc, eq, gte, lt, like, or, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { conversations, messages, memoryEpisodes } from '@/db/schema'
import { parseTemporalRange } from '@/memory/recall'
import type { Tool, ToolResult } from './index'

const MAX_MATCHES = 6
const SNIPPET_CHARS = 260

// Words that carry no search signal in a "what did we talk about" question.
const RECALL_STOPWORDS = new Set([
  'what', 'when', 'did', 'we', 'you', 'i', 'talk', 'talked', 'chat', 'chatted',
  'discuss', 'discussed', 'about', 'say', 'said', 'tell', 'told', 'mention',
  'mentioned', 'conversation', 'the', 'a', 'an', 'our', 'that', 'this', 'was',
  'were', 'do', 'have', 'had', 'me', 'my', 'us', 'yesterday', 'today', 'last',
  'week', 'month', 'night', 'morning', 'earlier', 'again', 'remember', 'recall',
  'and', 'or', 'of', 'in', 'on', 'to', 'for', 'with', 'ago', 'days', 'day',
])

function searchTokens(query: string): string[] {
  return [...new Set(
    query.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length >= 3 && !RECALL_STOPWORDS.has(t)),
  )].slice(0, 6)
}

function relativeLabel(d: Date): string {
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

export const recallConversationsTool: Tool = {
  id: 'recall_conversations',
  name: 'Past Conversations',
  description: "Search the user's own past conversations with the companion by topic or date",
  offline: true,
  dataSources: [], // local database only — nothing leaves the machine
  passMessage: 'query',
  examples: [
    'find what the user and the assistant talked about in an earlier conversation',
    'look up a past chat by topic or by when it happened',
    'recall what was discussed yesterday or last week in previous conversations',
    'search old conversations for something that was said before',
    'answer when a past conversation about a topic took place',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'recall_conversations',
      description:
        "Search the user's own past conversations (previous chats with the assistant) by topic keywords and/or a timeframe like 'yesterday' or 'last week'. Use for questions about what was previously discussed, not for facts about the world.",
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: "The user's question about past conversations, e.g. 'what did we talk about last week?' or 'when did we discuss the trip to Maine?'",
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query } = args as { query?: string }
    const userId = config?.['_userId'] as string | undefined
    if (!userId) return { success: false, error: 'No user context' }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    const range = parseTemporalRange(query)
    const tokens = searchTokens(query)
    if (!range && tokens.length === 0) {
      return { success: true, data: { results: [], answer_payload: { gist: 'No searchable topic or timeframe in the question.' } } }
    }

    // ── Raw message search (token-AND LIKE, scoped to this user's conversations) ──
    const likeConds: SQL[] = tokens.map((t) => like(messages.content, `%${t}%`))
    const conds: (SQL | undefined)[] = [eq(conversations.userId, userId)]
    if (range) {
      conds.push(gte(messages.createdAt, range.start), lt(messages.createdAt, range.end))
    }
    if (likeConds.length > 0) {
      // Token-AND when we have topic words; a pure-timeframe question matches all.
      conds.push(and(...likeConds))
    }

    const rows = await db
      .select({
        content: messages.content,
        role: messages.role,
        createdAt: messages.createdAt,
        convTitle: conversations.title,
        convId: conversations.id,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(60)

    // One best match per conversation, newest first.
    const seenConvs = new Set<string>()
    const matches: Array<{ when: string; conversation: string; speaker: string; snippet: string }> = []
    for (const r of rows) {
      if (seenConvs.has(r.convId)) continue
      seenConvs.add(r.convId)
      matches.push({
        when: relativeLabel(r.createdAt),
        conversation: r.convTitle ?? 'Untitled chat',
        speaker: r.role === 'user' ? 'they said' : 'you said',
        snippet: r.content.slice(0, SNIPPET_CHARS),
      })
      if (matches.length >= MAX_MATCHES) break
    }

    // ── Episode summaries as backup/overview (esp. pure-timeframe questions) ──
    const epConds: (SQL | undefined)[] = [eq(memoryEpisodes.userId, userId)]
    if (range) epConds.push(gte(memoryEpisodes.createdAt, range.start), lt(memoryEpisodes.createdAt, range.end))
    const epLikes: SQL[] = tokens.map((t) => like(memoryEpisodes.summary, `%${t}%`))
    if (!range && epLikes.length > 0) epConds.push(or(...epLikes))
    const episodes = await db
      .select({ summary: memoryEpisodes.summary, createdAt: memoryEpisodes.createdAt })
      .from(memoryEpisodes)
      .where(and(...epConds))
      .orderBy(desc(memoryEpisodes.createdAt))
      .limit(3)

    const summaries = episodes.map((e) => `(${relativeLabel(e.createdAt)}) ${e.summary}`)

    if (matches.length === 0 && summaries.length === 0) {
      return {
        success: true,
        data: {
          results: [],
          answer_payload: { gist: range ? 'No conversations found in that timeframe.' : 'Nothing found on that topic in past conversations.' },
        },
      }
    }

    return {
      success: true,
      data: {
        results: matches,
        summaries,
        answer_payload: {
          gist: `Found ${matches.length} past-chat match${matches.length === 1 ? '' : 'es'}${summaries.length ? ` and ${summaries.length} conversation summar${summaries.length === 1 ? 'y' : 'ies'}` : ''}.`,
          matches: matches.map((m) => `${m.when} (${m.conversation}), ${m.speaker}: "${m.snippet}"`),
          summaries,
        },
      },
    }
  },
}
