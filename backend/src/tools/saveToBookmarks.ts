import { createBookmark } from '@/lib/bookmarks/create'
import type { Tool, ToolResult } from './index'

// Companion tool: "save this for me" — save a URL into the user's Bookmarks library.
// Offline mode extracts the full article in the background; live just bookmarks it.
// Creation goes through the shared lib (same path as the route + Telegram bridge).

export const saveToBookmarksTool: Tool = {
  id: 'saveToBookmarks',
  name: 'Save to Bookmarks',
  description: "Save a web page or article to the user's Bookmarks library for later",
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
      name: 'saveToBookmarks',
      description: "Save a URL to the user's Bookmarks library. Use offline=true to keep the full article for offline reading.",
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
    if (!userId) return { success: false }
    if (!url || !/^https?:\/\//i.test(url)) {
      return {
        success: true,
        data: { saved: false },
        directReply: "I need the actual link to save it — paste the URL and I'll bookmark it.",
      }
    }

    const type = offline ? 'offline' : 'live'
    const item = await createBookmark({ ownerId: userId, url, type })
    return {
      success: true,
      data: { saved: true, itemId: item.id, url, type },
      directReply: type === 'offline'
        ? `Saved it to your bookmarks — I'm archiving an offline copy now.`
        : `Saved it to your bookmarks.`,
    }
  },
}
