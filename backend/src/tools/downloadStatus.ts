// Companion chat tool: "what's downloading?" / "is my movie ready?". Read-only view
// over the caller's media_requests rows plus (admins only) the live SABnzbd queue.

import { desc, eq } from 'drizzle-orm'
import type { Tool, ToolResult } from './index'
import { db } from '@/db'
import { mediaRequests } from '@/db/schema'
import { sabQueue } from '@/lib/media/sabnzbd'

export const downloadStatusTool: Tool = {
  id: 'download_status',
  name: 'Download status',
  description: 'Check what is downloading and whether requested movies/shows are ready to watch ("what\'s downloading?", "is my movie ready?").',
  offline: false,
  dataSources: [
    { name: 'SABnzbd', domain: 'local network', purpose: 'Read the live download queue on your self-hosted download client', type: 'api' },
  ],
  examples: [
    "what's downloading",
    'is my movie ready yet',
    'did dune finish downloading',
    'how are my downloads doing',
    'is severance ready to watch',
    'any of my requests done',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'download_status',
      description: 'Report the status of the user\'s requested movies/shows (requested, downloading with percent, ready to watch) and, for admins, the live household download queue. Use for any question about download progress or whether a requested title is ready.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Optional: a specific movie/show title the user asked about.' },
        },
      },
    },
  },

  async execute(args: unknown, config: Record<string, unknown> = {}): Promise<ToolResult> {
    const userId = config['_userId'] as string | undefined
    if (!userId) return { success: false, error: 'no user context' }
    const isAdmin = config['_isAdmin'] === true
    const { title } = (args ?? {}) as { title?: string }

    const rows = await db.select().from(mediaRequests)
      .where(eq(mediaRequests.userId, userId))
      .orderBy(desc(mediaRequests.updatedAt))
      .limit(25)

    const want = title?.trim().toLowerCase()
    const matched = want ? rows.filter((r) => r.title.toLowerCase().includes(want)) : rows
    const requests = matched.map((r) => ({
      title: r.title,
      year: r.year,
      type: r.mediaType,
      status: r.status,
      progress: r.status === 'downloading' && r.progress != null ? `${Math.round(r.progress)}%` : undefined,
    }))

    let queue: { paused: boolean; speed: string; items: Array<{ name: string; percent: number; timeLeft: string }> } | null = null
    if (isAdmin) {
      const q = await sabQueue()
      if (q) {
        queue = {
          paused: q.paused,
          speed: q.speed,
          items: q.slots.slice(0, 8).map((s) => ({ name: s.filename, percent: s.percentage, timeLeft: s.timeLeft })),
        }
      }
    }

    if (!requests.length && !queue) {
      return {
        success: true,
        data: { requests: [] },
        directReply: want
          ? `I don't see a request for "${title}". You can ask me to request it.`
          : 'Nothing is downloading right now, and you have no open requests.',
      }
    }

    return {
      success: true,
      data: { requests, queue },
      synthesisHint: 'Summarize the download situation conversationally: name each requested title with its status (requested, downloading with percent, ready to watch, or failed). If a queue is present, mention how many items are downloading and the current speed. Keep it brief.',
    }
  },
}
