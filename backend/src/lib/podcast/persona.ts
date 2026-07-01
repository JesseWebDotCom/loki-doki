// Per-show "cast" personas + their evolving per-episode "life beats".
//
// A show's hosts get topic-relative personas (an expert / a newcomer / an everyperson,
// or a single experienced voice) generated once, then a small slice of personal life
// that nudges forward each episode — back from a trip, mid-project, a hobby update —
// with light continuity so callbacks feel real. All of this is woven into the script as
// a SMALL part of each episode; it's never the point of the show. Internal only.

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import type { ShowConfig, ShowCast, EpisodeBeat } from './types'

interface HostInfo { id: string; name: string; personality: string }

const BEAT_HISTORY_CAP = 6
// Odds that one host sits an episode out — only ever considered for 3+ host shows, so
// the cast never collapses to a monologue. Kept low so absences feel like an occasional
// real-life thing, not a gimmick every episode.
const AWAY_CHANCE = 0.22

const topicOf = (show: ShowConfig): string =>
  [show.name, show.description].filter(Boolean).join(' — ').slice(0, 600)

/** A single host + briefing format = straight news read; no persona/backstory applies. */
const personasApply = (show: ShowConfig, hostCount: number): boolean =>
  !(hostCount === 1 && show.style === 'briefing')

function emptyCast(show: ShowConfig, hosts: HostInfo[]): ShowCast {
  return {
    topic: topicOf(show),
    members: hosts.map(h => ({ characterId: h.id, name: h.name, role: '', background: '', hobbies: [], beatHistory: [] })),
  }
}

/**
 * Build the cast once, keyed to the show's topic and host count. Multi-host shows get
 * complementary expertise (expert / newcomer / everyperson) for contrast; a lone host on
 * a non-news show becomes an experienced, opinionated voice. Best-effort: any failure
 * returns an empty (persona-less) cast so episodes still generate.
 */
export async function generateCast(show: ShowConfig, hosts: HostInfo[]): Promise<ShowCast> {
  if (!hosts.length || !personasApply(show, hosts.length)) return emptyCast(show, hosts)

  const multi = hosts.length > 1
  const roster = hosts.map(h => `- ${h.name} (id: ${h.id}) — base personality: ${h.personality}`).join('\n')
  const SYSTEM =
    'You design a recurring cast for an AI-hosted podcast. Given the show topic and its hosts, give each host a ' +
    'persona RELATIVE TO THE TOPIC that makes for good listening through contrast. ' +
    (multi
      ? 'Spread expertise across the hosts: at least one genuine expert with real hands-on experience in the topic, ' +
        'one who is newer and still experimenting, and (only if there are 3+) one relative outsider/everyperson who ' +
        'keeps things grounded. Give each a distinct angle — do NOT make them all experts. '
      : 'There is a single host: make them an experienced, opinionated voice with real hands-on background in the ' +
        'topic, able to give informed takes. ') +
    'Also give each host two short personal hobbies (for color, in or out of the topic). Keep each background to ' +
    'ONE vivid sentence. Return ONLY a JSON array, one object per host, in the SAME order as listed: ' +
    '[{"characterId":"<id>","role":"<short role label>","background":"<one sentence>","hobbies":["<a>","<b>"]}].'

  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Topic: ${topicOf(show)}\nFormat: ${show.style}\nHosts:\n${roster}` },
    ], undefined, { temperature: 0.9, num_predict: 600 })

    const arr = (resp.message?.content ?? '').match(/\[[\s\S]*\]/)?.[0]
    const parsed = (arr ? JSON.parse(arr) : []) as Record<string, unknown>[]
    const byId = new Map(parsed.filter(p => p && typeof p === 'object').map(p => [String(p.characterId ?? ''), p]))
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

    return {
      topic: topicOf(show),
      members: hosts.map((h, i) => {
        const p = byId.get(h.id) ?? parsed[i] ?? {}
        return {
          characterId: h.id,
          name: h.name,
          role: str(p.role),
          background: str(p.background),
          hobbies: Array.isArray(p.hobbies) ? p.hobbies.filter(x => typeof x === 'string').map(x => (x as string).trim()).slice(0, 3) : [],
          beatHistory: [],
        }
      }),
    }
  } catch {
    return emptyCast(show, hosts)
  }
}

/**
 * Produce this episode's personal beats — one short, fresh line per host that builds on
 * their recent life without repeating it. Occasionally (3+ host shows only) marks one host
 * as away for the episode. Best-effort: failure yields empty beats (still honoring any
 * chosen absence). Does NOT mutate the cast — call recordBeats() to persist the history.
 */
export async function advanceBeats(cast: ShowCast, style: string): Promise<EpisodeBeat[]> {
  const members = cast.members
  if (!members.length || (members.length === 1 && style === 'briefing')) return []

  let awayId = ''
  if (members.length >= 3 && Math.random() < AWAY_CHANCE) {
    awayId = members[Math.floor(Math.random() * members.length)]!.characterId
  }

  const ctx = members.map(m => {
    const recent = m.beatHistory.slice(-3)
    return `- ${m.name} (id: ${m.characterId})`
      + (m.hobbies.length ? `, hobbies: ${m.hobbies.join(', ')}` : '')
      + (recent.length ? `\n  recent life: ${recent.join(' | ')}` : '')
      + (m.characterId === awayId ? '\n  (AWAY this episode — give a brief reason for the absence, e.g. travelling or busy)' : '')
  }).join('\n')

  const SYSTEM =
    'You write a tiny "what\'s new with the hosts" note for one episode of an ongoing podcast. For EACH host write ' +
    'ONE short, natural sentence of personal life news that could be mentioned briefly on air — a hobby update, a ' +
    'small project, a trip, ordinary life. Build on their recent life where given (continuity and light callbacks ' +
    'are good) but say something NEW; never repeat a recent beat. Keep it grounded and low-key, not dramatic. ' +
    'Return ONLY a JSON array in the SAME order: [{"characterId":"<id>","beat":"<one sentence>"}].'

  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: ctx },
    ], undefined, { temperature: 1.0, num_predict: 400 })

    const arr = (resp.message?.content ?? '').match(/\[[\s\S]*\]/)?.[0]
    const parsed = (arr ? JSON.parse(arr) : []) as Record<string, unknown>[]
    const byId = new Map(parsed.filter(p => p && typeof p === 'object').map(p => [String(p.characterId ?? ''), String(p.beat ?? '').trim()]))

    return members.map((m, i) => ({
      characterId: m.characterId,
      name: m.name,
      beat: byId.get(m.characterId) || (typeof parsed[i]?.beat === 'string' ? (parsed[i]!.beat as string).trim() : ''),
      away: m.characterId === awayId,
    }))
  } catch {
    return members.map(m => ({ characterId: m.characterId, name: m.name, beat: '', away: m.characterId === awayId }))
  }
}

/**
 * Generate a per-video "angle" for each host — a one-sentence description of how their
 * standing role plays out for THIS specific content. Prevents the "tech expert being
 * overly technical about a lifestyle video" mismatch. Built from the episode content
 * summary (premise + beats) and each host's existing role. Best-effort: returns [] on
 * any failure so the script generator proceeds without it.
 */
export async function generateEpisodeAngles(
  members: { id: string; name: string; role: string; background: string }[],
  contentSummary: string,
): Promise<{ id: string; angle: string }[]> {
  if (!members.length || !contentSummary.trim()) return []

  const SYSTEM =
    'Given podcast hosts\' standing roles and this episode\'s specific content, write one ' +
    'short sentence per host describing their natural ANGLE for THIS episode. ' +
    'The angle should emerge from the content itself: if the content plays to a host\'s ' +
    'background, lean into that expertise; if it\'s outside their wheelhouse, make them ' +
    'the curious outsider. Keep it concrete — describe HOW they engage, not just that they do. ' +
    'Return ONLY JSON: [{"id":"<characterId>","angle":"<one sentence>"}]'

  const roster = members.map(m =>
    `- ${m.name} (id: ${m.id}) — standing role: ${m.role || 'co-host'}${m.background ? `. Background: ${m.background}` : ''}`,
  ).join('\n')

  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Hosts:\n${roster}\n\nThis episode's content:\n${contentSummary.slice(0, 2000)}` },
    ], undefined, { temperature: 0.8, num_predict: 300 }, undefined, 30_000)

    const arr = (resp.message?.content ?? '').match(/\[[\s\S]*\]/)?.[0]
    if (!arr) return []
    const parsed = JSON.parse(arr) as Record<string, unknown>[]
    return parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map(p => ({ id: String(p.id ?? '').trim(), angle: String(p.angle ?? '').trim() }))
      .filter(p => p.id && p.angle)
  } catch {
    return []
  }
}

/** Append this episode's beats to each host's rolling history (capped), in place. */
export function recordBeats(cast: ShowCast, beats: EpisodeBeat[]): void {
  for (const b of beats) {
    if (!b.beat) continue
    const m = cast.members.find(x => x.characterId === b.characterId)
    if (!m) continue
    m.beatHistory.push(b.beat)
    if (m.beatHistory.length > BEAT_HISTORY_CAP) m.beatHistory = m.beatHistory.slice(-BEAT_HISTORY_CAP)
  }
}
