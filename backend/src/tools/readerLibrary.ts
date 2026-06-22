import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { readerItems } from '@/db/schema'
import type { Tool, ToolResult } from './index'

// Companion tool: search the user's Reader library (saved links + offline articles)
// and return matches grounded in their stored text, so the companion can recall
// "what have I saved about X?" and discuss it.

function buildMatch(q: string): string {
  const tokens = q.toLowerCase().replace(/["*()^:]/g, ' ').split(/\s+/).filter((t) => t.length >= 2)
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(' ')
}

export const readerLibraryTool: Tool = {
  id: 'readerLibrary',
  name: 'Reading Library',
  description: "Search the user's saved articles, bookmarks and read-it-later items",
  offline: true,
  dataSources: [],
  examples: [
    'what have I saved about heat pumps',
    'find that article I bookmarked on sourdough',
    'search my reading list for the climate piece',
    'what was that link I saved yesterday',
    'show me my saved articles about react',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'readerLibrary',
      description: "Search the user's saved Reader library (bookmarks + offline articles) by keyword",
      parameters: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string', description: 'Keywords to search saved items for' } },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query } = (args ?? {}) as { query?: string }
    const userId = config?._userId as string | undefined
    if (!userId) return { success: false }
    const match = query ? buildMatch(query) : ''

    const conds = [or(isNull(readerItems.ownerId), eq(readerItems.ownerId, userId))]
    if (match) conds.push(sql`reader_items.rowid IN (SELECT rowid FROM reader_items_fts WHERE reader_items_fts MATCH ${match})`)

    const rows = await db.select().from(readerItems).where(and(...conds)).orderBy(desc(readerItems.createdAt)).limit(8)
    return {
      success: true,
      data: {
        count: rows.length,
        items: rows.map((r) => ({ title: r.title, url: r.url, excerpt: r.excerpt, type: r.type, savedAt: r.createdAt })),
        answer_payload: { gist: rows.length ? `Found ${rows.length} saved item(s) matching "${query}".` : `Nothing saved matching "${query}".` },
      },
    }
  },
}
