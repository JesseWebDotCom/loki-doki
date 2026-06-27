import type { Tool, ToolResult } from './index'
import {
  getPlexConnection,
  findInPlex,
  recentlyAdded,
  onDeck,
  sessions,
  searchDiscover,
  addToPlexWatchlist,
  removeFromPlexWatchlist,
  type PlexConnection,
} from '@/lib/plex'

// Plex tool — config surface (server URL + token in Admin → Features) plus a companion
// interface to the user's media server: "is X on my Plex?", "what's new on Plex?", "what am
// I watching?", "what's playing right now?", and add/remove from the account Watchlist.

function connFromConfig(config?: Record<string, unknown>): PlexConnection | null {
  const baseUrl = String(config?.['base_url'] ?? '').trim().replace(/\/+$/, '')
  const token = String(config?.['token'] ?? '').trim()
  if (!baseUrl || !token) return null
  return { baseUrl, token }
}

function ok(gist: string, extra?: Record<string, unknown>): ToolResult {
  return { success: true, data: { answer_payload: { gist, depth_available: false }, ...extra } }
}

type PlexAction = 'check' | 'recent' | 'ondeck' | 'now_playing' | 'add_watchlist' | 'remove_watchlist'

export const plexTool: Tool = {
  id: 'plex',
  name: 'Plex',
  description: 'Your Plex media server: check the library, see what\'s new or playing, manage your Watchlist',
  offline: false,
  passMessage: null,
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
      description: 'Your X-Plex-Token (Plex account/server token). Used to read your library and manage your Watchlist.',
      type: 'secret',
      scope: 'global',
      placeholder: 'xxxxxxxxxxxxxxxxxxxx',
    },
  ],
  examples: [
    'is a movie or show in my Plex library',
    'what\'s new on Plex',
    'what was recently added to Plex',
    'what am I watching on Plex',
    'what\'s playing on Plex right now',
    'add a title to my Plex watchlist',
    'remove something from my Plex watchlist',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'plex',
      description:
        'Interact with the user\'s Plex media server: check if a title is in the library, list recently added, list in-progress (on deck), show what\'s playing now, or add/remove a title from the account Watchlist.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['check', 'recent', 'ondeck', 'now_playing', 'add_watchlist', 'remove_watchlist'],
            description:
              'check = is a title in the library; recent = recently added; ondeck = continue-watching; now_playing = active streams; add_watchlist/remove_watchlist = manage the account Watchlist',
          },
          query: { type: 'string', description: 'The movie or show title (required for check, add_watchlist, remove_watchlist)' },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query, action } = (args ?? {}) as { query?: string; action?: PlexAction }
    const conn = connFromConfig(config) ?? (await getPlexConnection())
    if (!conn) return { success: false, error: 'Plex is not configured. Add a server URL and token in Admin → Features → Plex.' }
    const act: PlexAction = action ?? (query ? 'check' : 'recent')
    const title = query?.trim()

    switch (act) {
      case 'recent': {
        const items = await recentlyAdded(conn, 12)
        const list = items.map((i) => `${i.title}${i.year ? ` (${i.year})` : ''}`)
        return ok(
          list.length ? `Recently added to your Plex: ${list.slice(0, 8).join(', ')}.` : 'Nothing new has been added to your Plex library recently.',
          { items: list },
        )
      }
      case 'ondeck': {
        const items = await onDeck(conn, 12)
        const list = items.map((i) => i.episodeLabel ? `${i.title} — ${i.episodeLabel}` : i.title)
        return ok(
          list.length ? `On deck for you on Plex: ${list.slice(0, 8).join(', ')}.` : 'You don\'t have anything in progress on Plex right now.',
          { items: list },
        )
      }
      case 'now_playing': {
        const s = await sessions(conn)
        const lines = s.map((x) => `${x.user ?? 'Someone'} is watching ${x.showTitle ? `${x.showTitle} – ` : ''}${x.title}${x.player ? ` on ${x.player}` : ''}`)
        return ok(lines.length ? `Playing on Plex right now: ${lines.join('; ')}.` : 'Nothing is playing on your Plex server right now.', { sessions: lines })
      }
      case 'add_watchlist':
      case 'remove_watchlist': {
        if (!title) return { success: false, error: 'A title is required' }
        const verb = act === 'add_watchlist' ? 'add' : 'remove'
        const hit = (await searchDiscover(conn, { type: 'movie', title })) ?? (await searchDiscover(conn, { type: 'show', title }))
        if (!hit) return ok(`I couldn't find "${title}" to ${verb} ${act === 'add_watchlist' ? 'to' : 'from'} your Plex Watchlist.`)
        const done = act === 'add_watchlist' ? await addToPlexWatchlist(conn, hit.ratingKey) : await removeFromPlexWatchlist(conn, hit.ratingKey)
        return ok(
          done
            ? `${act === 'add_watchlist' ? 'Added' : 'Removed'} "${hit.title}"${hit.year ? ` (${hit.year})` : ''} ${act === 'add_watchlist' ? 'to' : 'from'} your Plex Watchlist.`
            : 'I wasn\'t able to update your Plex Watchlist just now.',
        )
      }
      case 'check':
      default: {
        if (!title) return { success: false, error: 'A title is required' }
        const [asMovie, asShow] = await Promise.all([
          findInPlex(conn, { type: 'movie', title }),
          findInPlex(conn, { type: 'show', title }),
        ])
        const hit = asMovie.present ? asMovie : asShow.present ? asShow : null
        const gist = hit
          ? `Yes — "${hit.title}"${hit.year ? ` (${hit.year})` : ''} is in your Plex library.`
          : `"${title}" doesn't appear to be in your Plex library.`
        return { success: true, data: { found: !!hit, match: hit, answer_payload: { gist, depth_available: false } } }
      }
    }
  },
}
