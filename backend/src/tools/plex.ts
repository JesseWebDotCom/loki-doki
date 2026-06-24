import type { Tool, ToolResult } from './index'
import { getPlexConnection, findInPlex, type PlexConnection } from '@/lib/plex'

// Plex tool — primarily a config surface (server URL + token shown in Admin → Features), and
// a companion lookup so "is X on my Plex?" works in chat. The Shows/Movies apps call the Plex
// lib directly for availability badges.

function connFromConfig(config?: Record<string, unknown>): PlexConnection | null {
  const baseUrl = String(config?.['base_url'] ?? '').trim().replace(/\/+$/, '')
  const token = String(config?.['token'] ?? '').trim()
  if (!baseUrl || !token) return null
  return { baseUrl, token }
}

export const plexTool: Tool = {
  id: 'plex',
  name: 'Plex',
  description: 'Check whether a movie or show is in your Plex library',
  offline: false,
  passMessage: 'query',
  dataSources: [{ name: 'Plex', domain: 'plex.tv', purpose: 'Your media server library', type: 'api' }],
  configSchema: [
    {
      key: 'base_url',
      label: 'Plex server URL',
      description: 'e.g. http://192.168.1.10:32400 — your Plex Media Server address',
      type: 'string',
      scope: 'global',
      placeholder: 'http://192.168.1.10:32400',
    },
    {
      key: 'token',
      label: 'Plex token',
      description: 'Your X-Plex-Token (Plex account/server token). Used to read your library.',
      type: 'secret',
      scope: 'global',
      placeholder: 'xxxxxxxxxxxxxxxxxxxx',
    },
  ],
  examples: [
    'is a movie or show in my Plex library',
    'do I have a title on Plex',
    'check my Plex server for a film or series',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'plex',
      description: 'Check whether a title is available in the user\'s Plex library',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string', description: 'The movie or show title' } },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query } = (args ?? {}) as { query?: string }
    const title = query?.trim()
    if (!title) return { success: false, error: 'A title is required' }

    const conn = connFromConfig(config) ?? (await getPlexConnection())
    if (!conn) return { success: false, error: 'Plex is not configured. Add a server URL and token in Admin → Features → Plex.' }

    const [asMovie, asShow] = await Promise.all([
      findInPlex(conn, { type: 'movie', title }),
      findInPlex(conn, { type: 'show', title }),
    ])
    const hit = asMovie.present ? asMovie : asShow.present ? asShow : null
    const gist = hit
      ? `Yes — "${hit.title}"${hit.year ? ` (${hit.year})` : ''} is in your Plex library.`
      : `"${title}" doesn't appear to be in your Plex library.`
    return { success: true, data: { found: !!hit, match: hit, answer_payload: { gist, depth_available: false } } }
  },
}
