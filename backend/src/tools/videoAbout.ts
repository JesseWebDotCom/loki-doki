// "What is this video about?" for the companion.
//
// The hub already understands videos properly (lib/videos/videoBrief.ts reads a whole
// transcript with the title and channel as context, lib/youtube/summarize.ts turns that
// into prose), but that understanding was reachable only from the video pages and the
// podcast generator. Jesse, 2026-08-10: "that smart summary needs to be universal and not
// locked to podcasts, I should be able to ask the companion about a video." This is that
// same pipeline as a tool, so asking about a video in chat gets the same answer the
// watch page shows, off one shared cache.
//
// Answering a specific question ("what did they think of the ending?") needs more than
// the summary, so a question also pulls a transcript excerpt for the assistant to read.

import type { Tool, ToolResult } from './index'
import { logger } from '@/lib/logger'

/** A bare 11-character YouTube id, or one embedded in any of its URL shapes. */
function youtubeIdFrom(input: string): string | null {
  const text = input.trim()
  if (/^[\w-]{11}$/.test(text)) return text
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/(?:embed|shorts|live|v)\/)([\w-]{11})/,
  ]
  for (const p of patterns) {
    const hit = text.match(p)
    if (hit?.[1]) return hit[1]
  }
  return null
}

export const videoAboutTool: Tool = {
  id: 'video_about',
  name: 'About a Video',
  description: 'Explain what a specific video is about, or answer a question about its content, by reading its transcript',
  offline: false,
  dataSources: [
    { name: 'YouTube (captions)', domain: 'youtube.com', purpose: 'The video\'s own transcript, summarized locally', type: 'web' },
  ],
  examples: [
    'what is this video about',
    'summarize this YouTube video for me',
    'what did they say about X in that video',
    'is this video worth watching',
    'what happens in this video',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'video_about',
      description:
        'Summarize a specific video, or answer a question about what is in it, by reading its transcript. ' +
        'Use when the user references a particular video (a pasted link, a video they are watching, or one ' +
        'you just found for them), NOT for searching for videos.',
      parameters: {
        type: 'object',
        required: ['video'],
        properties: {
          video: {
            type: 'string',
            description: 'The video: a YouTube URL or an 11-character YouTube video id',
          },
          question: {
            type: 'string',
            description: 'Optional specific question about the video, e.g. "what was their verdict?"',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { video, question } = args as { video?: string; question?: string }
    if (!video?.trim()) return { success: false, error: 'A video URL or id is required' }

    const videoId = youtubeIdFrom(video)
    if (!videoId) {
      return {
        success: false,
        error: 'That does not look like a YouTube link or video id. Search for the video first, then ask about it by id.',
      }
    }

    const userId = String(config?.['_userId'] ?? '').trim()
    if (!userId) return { success: false, error: 'No user context for this request' }

    try {
      const { eq } = await import('drizzle-orm')
      const { db } = await import('@/db')
      const { ytVideos } = await import('@/db/schema')
      const { ensureSummary } = await import('@/lib/youtube/summarize')
      const { firstNameOf } = await import('@/lib/precompute')

      const firstName = await firstNameOf(userId)
      const summary = await ensureSummary(videoId, userId, firstName)
      const [row] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)

      if (!summary) {
        return {
          success: true,
          data: {
            videoId,
            title: row?.title ?? null,
            channel: row?.author ?? null,
            summary: null,
            note: 'This video has no captions, so there is no transcript to read. Say so rather than guessing what it contains.',
          },
        }
      }

      // A specific question needs the source, not just the distillation.
      let transcript: string | null = null
      if (question?.trim()) {
        const { getTranscriptText } = await import('@/lib/youtube/transcript')
        transcript = (await getTranscriptText(videoId, userId, firstName))?.slice(0, 12_000) ?? null
      }

      return {
        success: true,
        data: {
          videoId,
          title: row?.title ?? null,
          channel: row?.author ?? null,
          durationSec: row?.durationSec ?? null,
          route: `/videos/youtube/watch/${videoId}`,
          summary,
          ...(transcript ? { transcriptExcerpt: transcript } : {}),
          note: question?.trim()
            ? 'Answer the question from the transcript excerpt and summary. Say when the transcript does not cover it.'
            : 'Summarize this for the user in a sentence or two, then offer to play it at the route.',
        },
      }
    } catch (err) {
      logger.warn(`[video_about] failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: 'Could not read that video' }
    }
  },
}
