// Companion chat tool: "download the new Dune movie" / "request Severance".
// NEVER files directly — resolves ONE best candidate (name, year, poster), stages the
// request via lib/companionActions, and shows a confirm card (poster + "Title (Year)")
// on every surface. Only an explicit approval executes fileRequest, through the same
// admin-chosen pipeline and per-user permissions the detail-page Request button uses.

import type { Tool, ToolResult } from './index'
import { stageWithDirective } from '@/lib/companionActions'
import {
  getRequestPipeline, overseerrSearch, radarrLookup, sonarrLookup,
} from '@/lib/media/integrations'
import { canUserRequest, fileRequest } from '@/lib/media/requests'
import { searchShows } from '@/lib/shows/tvmaze'

interface Candidate {
  type: 'movie' | 'show'
  title: string
  year: number | null
  posterUrl: string | null
  tmdbId: number | null
  tvdbId: number | null
}

async function findCandidate(title: string, type: 'movie' | 'show'): Promise<Candidate | null> {
  const pipeline = await getRequestPipeline()
  if (pipeline === 'overseerr') {
    const hit = await overseerrSearch(title, null, type)
    if (!hit) return null
    return { type, title: hit.title, year: hit.year, posterUrl: hit.posterUrl, tmdbId: hit.tmdbId, tvdbId: null }
  }
  if (type === 'movie') {
    const hit = await radarrLookup({ title })
    if (!hit) return null
    return { type, title: hit.title, year: hit.year, posterUrl: hit.posterUrl, tmdbId: hit.tmdbId, tvdbId: null }
  }
  const hit = await sonarrLookup({ title })
  if (!hit) return null
  return { type, title: hit.title, year: hit.year, posterUrl: hit.posterUrl, tmdbId: null, tvdbId: hit.tvdbId }
}

/** refId convention (matches the Shows/Movies apps): TVMaze id for shows, title for
 *  movies — so a companion request and the detail-page button track the same row. */
async function resolveRefId(candidate: Candidate): Promise<string> {
  if (candidate.type === 'movie') return candidate.title
  try {
    const [match] = await searchShows(candidate.title, 1)
    if (match?.id) return String(match.id)
  } catch { /* fall through */ }
  return candidate.tmdbId ? `tmdb:${candidate.tmdbId}` : candidate.title
}

export const requestMediaTool: Tool = {
  id: 'request_media',
  name: 'Request downloads',
  description: 'Request a movie or TV show for the household media library ("download the new Dune movie", "request Severance"). Always confirms the exact title with the user before filing.',
  offline: false,
  dataSources: [
    { name: 'Radarr/Sonarr/Overseerr', domain: 'local network', purpose: 'Search titles and file download requests on your self-hosted media managers', type: 'api' },
  ],
  examples: [
    'download the new dune movie',
    'request severance',
    'get me oppenheimer',
    'can you download the bear',
    'add the latest mission impossible to the library',
    'request the show silo',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'request_media',
      description: 'Request that a movie or TV show be downloaded and added to the household media library. Extracts the title from the user\'s message. The user is always shown the matched title and must confirm before anything is filed.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The movie or show title the user wants, e.g. "Dune: Part Two" or "Severance".' },
          mediaType: { type: 'string', enum: ['movie', 'show', 'unknown'], description: 'Whether it is a movie or a TV show, if the user made it clear. Use "unknown" if ambiguous.' },
        },
        required: ['title'],
      },
    },
  },

  async execute(args: unknown, config: Record<string, unknown> = {}): Promise<ToolResult> {
    const userId = config['_userId'] as string | undefined
    if (!userId) return { success: false, error: 'no user context' }
    const isAdmin = config['_isAdmin'] === true
    const { title: rawTitle, mediaType } = (args ?? {}) as { title?: string; mediaType?: string }
    const title = rawTitle?.trim()
    if (!title) return { success: false, error: 'no title given' }

    const permission = await canUserRequest(userId, isAdmin)
    if (!permission.ok) {
      const reply = permission.reason === 'unconfigured'
        ? 'Download requests are not set up yet. An admin can connect Radarr, Sonarr, or Overseerr in Admin, then Integrations, then Downloads.'
        : permission.reason === 'link_plex'
          ? 'You need a linked Plex account to request downloads. You can link it in the Movies app settings.'
          : 'You do not have permission to request downloads. An admin can grant it in the Downloads settings.'
      return { success: true, data: { canRequest: false }, directReply: reply }
    }

    // Resolve one best candidate; if the type is ambiguous try movie first, then show.
    let candidate: Candidate | null = null
    if (mediaType === 'show') {
      candidate = await findCandidate(title, 'show')
    } else if (mediaType === 'movie') {
      candidate = await findCandidate(title, 'movie')
    } else {
      candidate = (await findCandidate(title, 'movie')) ?? (await findCandidate(title, 'show'))
    }
    if (!candidate) {
      return {
        success: true,
        data: { found: false },
        directReply: `I couldn't find "${title}" to request. Could you try the exact title, and tell me if it's a movie or a show?`,
      }
    }

    const display = candidate.year ? `${candidate.title} (${candidate.year})` : candidate.title
    const kind = candidate.type === 'show' ? 'show' : 'movie'
    const resolved = candidate
    const { directive } = stageWithDirective({
      userId,
      conversationId: String(config['_conversationId'] ?? ''),
      toolId: 'request_media',
      summary: `request the ${kind} "${display}"`,
      approveLabel: 'Request it',
      declineLabel: 'Cancel',
      card: {
        title: resolved.title,
        subtitle: [resolved.year, kind === 'show' ? 'TV show' : 'Movie'].filter(Boolean).join(' · '),
        ...(resolved.posterUrl ? { imageUrl: resolved.posterUrl } : {}),
      },
      execute: async () => {
        const refId = await resolveRefId(resolved)
        await fileRequest(userId, {
          type: resolved.type, title: resolved.title, year: resolved.year,
          tvdb: resolved.tvdbId, tmdbId: resolved.tmdbId, posterUrl: resolved.posterUrl,
          refId, origin: 'companion',
        })
        return `Done — "${display}" is requested. I'll let you know when it's ready to watch.`
      },
    })
    return {
      success: true,
      data: { pendingConfirm: true, title: resolved.title, year: resolved.year },
      directReply: `I found the ${kind} "${display}". Want me to request it?`,
      directive,
    }
  },
}
