import { db } from '@/db'
import { readerItems } from '@/db/schema'
import { enqueueArchiveArticle } from '@/lib/downloadJobs'
import type { Tool, ToolResult } from './index'

// Companion tool: "save this for me" — save a URL into the user's Reader library.
// Offline mode extracts the full article in the background; live just bookmarks it.

export const saveToReaderTool: Tool = {
  id: 'saveToReader',
  name: 'Save to Reader',
  description: "Save a web page or article to the user's Reader library for later",
  offline: true,
  dataSources: [],
  examples: [
    'save this article for me',
    'add this link to my reading list',
    'save https://example.com to read later',
    'bookmark this page',
    'keep this for later',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'saveToReader',
      description: "Save a URL to the user's Reader library. Use offline=true to keep the full article for offline reading.",
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'The URL to save' },
          offline: { type: 'boolean', description: 'true = save full article offline; false = just bookmark the link' },
        },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { url, offline } = (args ?? {}) as { url?: string; offline?: boolean }
    const userId = config?._userId as string | undefined
    if (!userId || !url || !/^https?:\/\//i.test(url)) return { success: false }

    const type = offline ? 'offline' : 'live'
    const now = new Date()
    const id = crypto.randomUUID()
    await db.insert(readerItems).values({
      id, ownerId: userId, source: type === 'offline' ? 'article' : 'bookmark', sourceRef: null, type,
      url: url.trim(), title: url.trim(), byline: null, siteName: null, faviconUrl: null, excerpt: null,
      contentHtml: null, contentText: null, wordCount: 0, readingMins: 0,
      status: 'unread', archiveState: type === 'offline' ? 'pending' : 'none', archiveError: null, readAt: null,
      useProxy: false, useEmbed: false, category: 'Other', collectionId: null, sortOrder: 0,
      screenshotPath: null, snapshotPath: null, ogImagePath: null, isAdult: false, createdAt: now, updatedAt: now,
    })
    if (type === 'offline') await enqueueArchiveArticle(id, url.trim())

    return {
      success: true,
      data: { saved: true, url, type, answer_payload: { gist: `Saved ${url} to your Reader library${type === 'offline' ? ' for offline reading' : ''}.` } },
    }
  },
}
