// Render a BriefingPayload into a SHORT prompt block. This rides every companion turn,
// so it is aggressively budgeted: ~700 chars / ~180 tokens hard cap. URLs are dropped
// (the buddy speaks, it doesn't link). When over budget we trim whole sections in a
// fixed low-value-first order. The block is followed by ONE weave-in instruction line —
// the primary defense against the model reciting context unprompted.

import type { BriefingPayload, BriefingItem } from './types'

export interface RenderLimits {
  localNews: number
  localEvents: number
  worldNews: number
  sports: number
}

const CHAR_CAP = 700

const WEAVE_INSTRUCTION =
  'You ambiently know the local/world context above. Weave a detail in ONLY when it is ' +
  "genuinely relevant to what the user said (their day, plans, weather, or current events). " +
  'Do not recite it, list it, or bring it up unprompted. Stay brief and natural.'

function itemLine(it: BriefingItem, max = 90): string {
  let s = it.title.trim()
  if (it.detail) s += ` — ${it.detail.trim()}`
  s = s.replace(/\s+/g, ' ')
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

function joinItems(items: BriefingItem[], n: number, sep = '; '): string {
  return items.slice(0, n).map((it) => itemLine(it)).filter(Boolean).join(sep)
}

// Build the labeled lines for a payload at the given section limits.
function buildLines(p: BriefingPayload, limits: RenderLimits): string[] {
  const lines: string[] = []
  lines.push(`[Local context — ${p.location}, ${p.date}]`)
  if (p.weather) lines.push(`Weather: ${p.weather}`)
  if (p.holidays.length) lines.push(`Today: ${joinItems(p.holidays, 2)}`)
  if (p.localNews.length) lines.push(`Local news: ${joinItems(p.localNews, limits.localNews)}`)
  if (p.localEvents.length) lines.push(`Local events: ${joinItems(p.localEvents, limits.localEvents)}`)
  if (p.sports.length) lines.push(`Sports: ${joinItems(p.sports, limits.sports)}`)
  if (p.worldNews.length) lines.push(`World: ${joinItems(p.worldNews, limits.worldNews)}`)
  if (p.notableDeaths.length) lines.push(`Notable: ${joinItems(p.notableDeaths, 1)}`)
  if (p.onThisDay.length) lines.push(`On this day: ${joinItems(p.onThisDay, 2)}`)
  return lines
}

/**
 * Render the full block (context lines + weave instruction). Returns '' if there is
 * nothing beyond the header worth saying (caller treats '' as "no block").
 */
export function renderBriefingBlock(p: BriefingPayload, limits: RenderLimits): string {
  // Trim order: drop lowest-value sections first until under the char cap.
  // Sections are dropped by zeroing them out of a working copy.
  const work: BriefingPayload = { ...p }
  const lim: RenderLimits = { ...limits }

  const trimSteps: Array<() => void> = [
    () => { work.notableDeaths = [] },
    () => { work.onThisDay = [] },
    () => { lim.sports = Math.min(lim.sports, 2) },
    () => { lim.worldNews = Math.min(lim.worldNews, 1) },
    () => { lim.localEvents = Math.min(lim.localEvents, 2) },
    () => { lim.localNews = Math.min(lim.localNews, 2) },
    () => { work.worldNews = [] },
    () => { work.sports = [] },
    () => { work.localEvents = [] },
    () => { work.localNews = [] },
  ]

  let lines = buildLines(work, lim)
  let body = lines.join('\n')
  let step = 0
  while (body.length > CHAR_CAP && step < trimSteps.length) {
    trimSteps[step]!()
    step++
    lines = buildLines(work, lim)
    body = lines.join('\n')
  }

  // Header-only (just the date line) → nothing useful; let the caller omit it.
  if (lines.length <= 1 && !work.weather) return ''
  return `${body}\n\n${WEAVE_INSTRUCTION}`
}

export { CHAR_CAP as BRIEFING_CHAR_CAP }
