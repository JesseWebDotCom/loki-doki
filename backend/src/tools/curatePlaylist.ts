// Curate Playlist — the companion's "talk to build a playlist" ability.
//
// Create a playlist from a described vibe ("make me a playlist of upbeat 90s hip
// hop"), then keep refining it in conversation: "add some Bad Bunny", "make it more
// upbeat", "drop the last one". The tool holds a short-lived per-user curation
// session (curationSession.ts) so those follow-ups know which playlist to touch;
// runCompanionTurn routes refine-shaped phrases back here while a session is live.
//
// The playlist is saved to the user's library (kind 'magic', re-rollable) and opened
// on screen via an open_playlist directive — but NOT auto-played (a deliberate choice:
// building/tweaking shouldn't hijack whatever audio is going).

import type { Tool, ToolResult, OpenPlaylistDirective } from './index'
import {
  createCuratedPlaylist, addToCuratedPlaylist, removeLastTrack, removeMatchingTrack,
  regenerateFromRecipe, CurateError,
} from '@/lib/music/curate'
import { getActiveCuration, setActiveCuration } from '@/lib/music/curationSession'

type Intent = 'create' | 'add' | 'remove' | 'adjust'

// ── Intent + subject extraction ──────────────────────────────────────────────
// Mirrors playMusic.ts's classify(): an explicit Tier-2 `intent` wins; otherwise a
// small heuristic reads the shape of the utterance.

function classifyIntent(q: string): Intent {
  const s = q.toLowerCase()
  if (/^\s*(?:also |and |then )?(?:can you |could you |please )?(?:remove|take (?:out|off|away)|drop|delete|get rid of)\b/.test(s) || /\btake\b[^.?!]*\b(?:off|out)\b/.test(s)) return 'remove'
  if (/\bmake it (?:more|less)\b/.test(s) || /^\s*(?:make it |a bit )?(?:more|less)\b/.test(s)) return 'adjust'
  if (/^\s*(?:also |and |then )?(?:can you |could you |please )?(?:add|include|throw in|toss in|put in|mix in|sprinkle in|a few more|some more|more of)\b/.test(s)) return 'add'
  return 'create'
}

// "make me a playlist of X" → "X"; "build a workout playlist" → "workout".
// Strips the build verb, the article, throwaway adjectives, and the playlist/mix noun
// (wherever it sits) so the leftover is a clean, name-worthy vibe.
const CREATE_VERB_RE = /^(?:hey\s+)?(?:can you|could you|would you|will you|please|go ahead and|now|i(?:'?d| would)?\s*(?:want|like|love)?\s*(?:to\s+)?)?\s*(?:make|build|create|put together|start|generate|curate|whip up|throw together|give me|get me|set up)\s+(?:me\s+)?/i
function extractVibe(q: string): string {
  const v = q.replace(CREATE_VERB_RE, '')
    .replace(/^(?:a|an|the|some|another|one)\s+/i, '')
    .replace(/\b(?:new|short|quick|little|nice|good|fresh)\s+/gi, ' ')
    .replace(/\b(?:playlist|mix|set)\b\s*(?:of|for|with|about|to)?/i, ' ')
    .replace(/\s+/g, ' ').trim()
  return v || q.trim()
}

// "add some Bad Bunny" → "Bad Bunny"; "add a few more upbeat ones" → "upbeat"
const ADD_LEAD_RE = /^(?:also |and |then )?(?:can you |could you |please )?(?:add|include|throw in|toss in|put in|mix in|sprinkle in)\s+(?:in\s+)?(?:some|a few|a couple(?: of)?|a bunch of|more|several)?\s*/i
function extractAddSubject(q: string): string {
  return q.replace(ADD_LEAD_RE, '')
    .replace(/\b(?:songs?|tracks?|tunes?|ones?)\b/gi, ' ')
    .replace(/\bto (?:the|my|this)\s+playlist\b/gi, ' ')
    .replace(/\s+/g, ' ').trim()
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

const NAMED = (t: { title: string; artist: string | null }) =>
  t.artist ? `"${t.title}" by ${t.artist}` : `"${t.title}"`

export const curatePlaylistTool: Tool = {
  id: 'curate_playlist',
  name: 'Curate Playlist',
  description: 'Build a playlist from a described vibe and refine it by voice — add songs or artists, remove a track, or adjust the vibe',
  offline: false,
  passMessage: 'query',
  dataSources: [
    { name: 'YouTube (InnerTube)', domain: 'youtube.com', purpose: 'Resolve proposed songs to playable tracks', type: 'web' },
  ],
  examples: [
    'make me a playlist of upbeat 90s hip hop',
    'build me a dinner party playlist',
    'put together a chill study playlist',
    'create a playlist of sad indie songs',
    'start a road trip playlist',
    'curate a playlist for working out',
    'add some Bad Bunny',
    'add a few more upbeat songs',
    'throw in some Fleetwood Mac',
    'make it more upbeat',
    'make it more mellow',
    'remove the last one',
    'take that song off the playlist',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'curate_playlist',
      description:
        'Build a NEW playlist from a described vibe, or refine the playlist currently being curated: add songs/artists, remove a track, or adjust the vibe ("make it more upbeat"). Use when the user wants to MAKE or CHANGE a playlist — not just play something (that is play_music).',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'The full request, e.g. "a playlist of 90s hip hop", "some Bad Bunny", "make it more upbeat", "remove the last one"',
          },
          intent: {
            type: 'string',
            enum: ['create', 'add', 'remove', 'adjust'],
            description: 'create a new playlist; add tracks; remove a track; adjust/re-roll the vibe of the current playlist',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const a = (args ?? {}) as { query?: string; intent?: string }
    const userId = config?.['_userId'] as string | undefined
    const raw = (a.query ?? (config?.['_rawMessage'] as string | undefined) ?? '').trim()
    if (!userId) return { success: false, error: 'No user in context' }
    if (!raw) return { success: false, error: 'Nothing to curate' }

    const intent: Intent = a.intent && ['create', 'add', 'remove', 'adjust'].includes(a.intent)
      ? (a.intent as Intent)
      : classifyIntent(raw)
    const active = getActiveCuration(userId)

    try {
      // ── CREATE (also the fallback when a refine has no live session) ──────────
      if (intent === 'create' || (!active && intent !== 'remove')) {
        const vibe = intent === 'create' ? extractVibe(raw) : (intent === 'add' ? extractAddSubject(raw) || raw : raw)
        const { id, name, trackCount } = await createCuratedPlaylist(userId, { vibe, count: 20 })
        setActiveCuration(userId, id, name)
        const directive: OpenPlaylistDirective = { action: 'open_playlist', playlistId: id, name, trackCount, autoplay: false }
        return {
          success: true,
          data: { action: 'create', playlistId: id, name, trackCount },
          directive,
          synthesisHint:
            `[Playlist ready]: You just built them a ${trackCount}-song playlist called "${name}" and it's now open on screen (not playing yet). ` +
            `Give one short, warm, in-character line — say the name, don't list the songs — and offer to tweak it ` +
            `("want it more upbeat, or should I add an artist?").`,
        }
      }

      // Everything below needs a live session (guaranteed for remove; add/adjust
      // fell through here only because `active` is set).
      if (!active) {
        return { success: true, directReply: "You don't have a playlist going right now. Want me to start one?" }
      }

      // ── ADD ──────────────────────────────────────────────────────────────────
      if (intent === 'add') {
        const subject = extractAddSubject(raw) || `more like ${active.name}`
        const { added } = await addToCuratedPlaylist(userId, active.playlistId, subject, 5)
        setActiveCuration(userId, active.playlistId, active.name)
        return {
          success: true,
          data: { action: 'add', added, playlistId: active.playlistId },
          synthesisHint: added > 0
            ? `[Added]: You just added ${added} ${titleCase(subject)} track${added === 1 ? '' : 's'} to "${active.name}". One short in-character line confirming it — don't list them all.`
            : `[Nothing added]: You couldn't find fresh ${titleCase(subject)} tracks to add (they may already be on it). Say so briefly and offer an alternative.`,
        }
      }

      // ── ADJUST (re-roll the whole playlist toward a new direction) ────────────
      if (intent === 'adjust') {
        const n = await regenerateFromRecipe(userId, active.playlistId, raw)
        setActiveCuration(userId, active.playlistId, active.name)
        return {
          success: true,
          data: { action: 'adjust', playlistId: active.playlistId, trackCount: n },
          synthesisHint:
            `[Reworked]: You just re-rolled "${active.name}" based on their note ("${raw}") — it's ${n} songs now. ` +
            `One short in-character line letting them know it's refreshed.`,
        }
      }

      // ── REMOVE ───────────────────────────────────────────────────────────────
      const wantsLast = /\b(last|previous|that one|this one|it)\b/i.test(raw)
      const removed = wantsLast
        ? await removeLastTrack(active.playlistId)
        : (await removeMatchingTrack(active.playlistId, raw)) ?? null
      setActiveCuration(userId, active.playlistId, active.name)
      return {
        success: true,
        data: { action: 'remove', playlistId: active.playlistId, removed },
        synthesisHint: removed
          ? `[Removed]: You took ${NAMED(removed)} off "${active.name}". One short in-character line confirming it.`
          : `[Not found]: You couldn't find that track on "${active.name}" to remove. Say so briefly and ask which one they mean.`,
      }
    } catch (err) {
      if (err instanceof CurateError) {
        return {
          success: true,
          synthesisHint: `[Couldn't do it]: ${err.code === 'insufficient'
            ? 'That vibe did not turn up enough real songs.'
            : 'That is not a playlist you can re-roll.'} Tell them briefly and ask them to reword it.`,
        }
      }
      return { success: false, error: String(err) }
    }
  },
}
