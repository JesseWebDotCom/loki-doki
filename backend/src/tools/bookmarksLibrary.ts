import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks } from '@/db/schema'
import { retrieveBookmarkChunks } from '@/lib/bookmarks/chunks'
import type { Tool, ToolResult } from './index'

// Companion tool: search the user's Bookmarks library (saved links + offline articles)
// and return matches grounded in their stored text, so the companion can recall
// "what have I saved about X?" and discuss it.

function buildMatch(q: string): string {
  const tokens = q.toLowerCase().replace(/["*()^:]/g, ' ').split(/\s+/).filter((t) => t.length >= 2)
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(' ')
}

export const bookmarksLibraryTool: Tool = {
  id: 'bookmarksLibrary',
  name: 'Bookmarks Library',
  description: "Search the user's saved articles, bookmarks and read-it-later items, or list their reading queue",
  offline: true,
  dataSources: [],
  examples: [
    'what have I saved about heat pumps',
    'find that article I bookmarked on sourdough',
    'search my reading list for the climate piece',
    'what was that link I saved yesterday',
    'show me my saved articles about react',
    "what's in my reading list",
    'what should I read next',
    'how many unread articles do I have',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'bookmarksLibrary',
      description: "Search the user's saved Bookmarks library (bookmarks + offline articles) by keyword, or list their unread reading queue",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search saved items for (omit when listing the queue)' },
          queue: { type: 'boolean', description: "true when the user asks what's in their reading list / what to read next" },
        },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query, queue } = (args ?? {}) as { query?: string; queue?: boolean }
    const userId = config?._userId as string | undefined
    if (!userId) return { success: false }

    // Reading queue: unread + reading items, newest first, with reading time.
    if (queue || !query?.trim()) {
      const rows = await db.select().from(bookmarks)
        .where(and(
          or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, userId)),
          eq(bookmarks.type, 'offline'),
          or(eq(bookmarks.status, 'unread'), eq(bookmarks.status, 'reading')),
        ))
        .orderBy(desc(bookmarks.createdAt))
      const top = rows.slice(0, 5)
      const list = top.map((r, i) => `${i + 1}. ${r.title}${r.readingMins ? ` — ${r.readingMins} min` : ''}${r.siteName ? ` (${r.siteName})` : ''}`).join('\n')
      return {
        success: true,
        data: { count: rows.length, items: top.map((r) => ({ title: r.title, url: r.url, readingMins: r.readingMins })) },
        directReply: rows.length
          ? `Your reading queue has ${rows.length} article${rows.length === 1 ? '' : 's'}:\n${list}${rows.length > 5 ? `\n…and ${rows.length - 5} more in Bookmarks.` : ''}`
          : 'Your reading queue is clear — nothing saved and unread right now.',
      }
    }

    const match = buildMatch(query)
    const conds = [or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, userId))]
    if (match) conds.push(sql`bookmarks.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ${match})`)
    let rows = await db.select().from(bookmarks).where(and(...conds)).orderBy(desc(bookmarks.createdAt)).limit(8)
    let matched: 'keyword' | 'semantic' = 'keyword'

    // FTS miss → semantic fallback over embedded article chunks ("that piece about the
    // housing market" phrased differently). Empty when embeddings are unavailable.
    if (!rows.length) {
      const hits = await retrieveBookmarkChunks(userId, query, 6).catch(() => [])
      const ids = [...new Set(hits.map((h) => h.bookmarkId))]
      if (ids.length) {
        rows = await db.select().from(bookmarks).where(inArray(bookmarks.id, ids)).limit(8)
        matched = 'semantic'
      }
    }

    return {
      success: true,
      data: {
        count: rows.length,
        matched,
        items: rows.map((r) => ({ title: r.title, url: r.url, excerpt: r.excerpt, type: r.type, savedAt: r.createdAt })),
        answer_payload: { gist: rows.length ? `Found ${rows.length} saved item(s) matching "${query}".` : `Nothing saved matching "${query}".` },
      },
    }
  },
}
