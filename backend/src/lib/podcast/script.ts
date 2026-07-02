// LLM script generation for podcast episodes.
// Input: show config + collected segment content
// Output: ordered array of { host, text } turns
//
// Architecture: SEGMENT-DRIVEN generation. A local 8B model reliably emits only a few
// hundred words per call no matter what total is demanded, so we never ask for a whole
// episode at once. Instead the episode outline is the unit of work — each outline segment
// gets its own generation call with its own word budget, the tail of the previous segment
// (for a seamless join), and the list of parts already covered (so nothing repeats).
// Length is enforced by construction: the per-segment budgets sum to the episode target,
// and a segment that comes back short is retried individually.

import { getScriptModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import type { ShowConfig, ScriptTurn, SegmentContent, CastBrief } from './types'
import { generateEpisodeOutline, fallbackOutline, padOutline, formatOutlineBlock, type EpisodeOutline, type OutlineSegment } from './outline'
import { generateEpisodeAngles } from './persona'

// Per-style direction plus an explicit total word target. LLMs hit a word count far
// more reliably than a "minutes" hint. ~165 spoken words/min at our 1.2x playback floor,
// so targetWords ≈ minutes × 165.
const STYLE_INSTRUCTIONS: Record<string, { guide: string; targetWords: number }> = {
  'recap':       { guide: 'Conversational recap — summarize what happened, hit the highlights, and react to them. Friendly and informative.', targetWords: 1100 },
  'in-depth':    { guide: 'Thorough and analytical — explore context, implications, and the "why it matters" behind each item. Go deep on the details.', targetWords: 2000 },
  'roundtable':  { guide: 'Hosts debate and discuss from different perspectives. Let them agree, disagree, and riff off each other at length.', targetWords: 1850 },
  'interview':   { guide: 'Q&A format — the first host asks probing questions, the second answers as an expert and goes deep on each one.', targetWords: 1750 },
  'briefing':    { guide: 'Professional news-anchor style. Factual, direct, and well-paced through every story.', targetWords: 900 },
  'story':       { guide: 'Narrative storytelling — vivid language, a clear arc, scene by scene.', targetWords: 1400 },
}

/** Count spoken words across all turns. */
function countWords(turns: { text: string }[]): number {
  return turns.reduce((n, t) => n + (t.text.trim().match(/\S+/g)?.length ?? 0), 0)
}

// Context window for script generation. The default Ollama context (2048) would let the
// source material crowd out the room to generate; per-segment calls are small enough that
// 8192 comfortably fits the system prompt, the material, and the segment's output.
const SCRIPT_NUM_CTX = 8192

// Segment-level generation calls may hit a cold VRAM load (fast-model pre-passes can evict
// the script model), so give each call generous headroom over the default 120s.
const SCRIPT_TIMEOUT_MS = 5 * 60_000

// Turns whose text claims the source creator's property as the hosts' own (their channel,
// Discord, website…) or plug subscriptions/URLs. A weak model drifts into these in outros;
// they instantly break the "outside commentators" illusion, and none are ever load-bearing.
const IDENTITY_LEAK =
  /\b(?:our|my) (?:channel|videos?|discord|patreon|website|site|merch|subreddit)\b|notification bell|smash (?:that|the) like|https?:\/\/|\bwww\.|\.(?:com|net|org|tv)\b|subscribe to (?:us|our|the channel)/i

interface HostInfo {
  id: string
  name: string
  personality: string
}

export async function generateScript(
  show: ShowConfig,
  segments: SegmentContent[],
  hostInfos: HostInfo[],
  cast?: CastBrief,
): Promise<ScriptTurn[]> {
  const style = STYLE_INSTRUCTIONS[show.style] ?? STYLE_INSTRUCTIONS['recap']!
  // Per-show override takes precedence; fall back to the style default.
  const targetWords = show.targetMinutes != null
    ? Math.round(Math.max(2, show.targetMinutes) * 165)
    : style.targetWords
  const targetMinutes = Math.max(2, Math.round(targetWords / 165))

  const contentSummary = segments
    .filter(s => s.items.length > 0)
    .map(s => `## ${s.label}\n${s.items.map(i => `- ${i}`).join('\n')}`)
    .join('\n\n')

  // Size the arc to the length target. Measured on 8B local models: a generation call
  // emits ~230-270 words no matter how many are requested (asking for 450 still returns
  // ~240), so length comes from segment COUNT — one segment per ~240 words — not from
  // bigger per-segment asks.
  const bodyCount = Math.max(3, Math.min(8, Math.ceil(targetWords / 240) - 2))

  // Outline + angles are independent — run in parallel to avoid two serial round-trips
  // before the main model calls.
  const [outlineMaybe, episodeAngles] = await Promise.all([
    generateEpisodeOutline(contentSummary, bodyCount).catch(() => null),
    cast?.members?.length
      ? generateEpisodeAngles(cast.members, contentSummary).catch(() => [])
      : Promise.resolve([]),
  ])
  const outline = padOutline(outlineMaybe ?? fallbackOutline(bodyCount), bodyCount)
  if (!outlineMaybe) console.log('[podcast] outline generation failed — using generic fallback arc')
  const angleById = new Map(episodeAngles.map(a => [a.id, a.angle]))

  const systemPrompt = buildSystemPrompt(show, style.guide, outline, hostInfos, cast, angleById)
  // Local models consistently deliver ~75-80% of an asked-for word count even per-segment,
  // so budgets are padded — asking for 125% is what actually lands ~100% of the target.
  const budgets = segmentBudgets(outline.segments, Math.round(targetWords * 1.25))
  const isMultiHost = hostInfos.length > 1
  const model = await getScriptModel()

  const materialBlock = contentSummary
    ? `SOURCE MATERIAL (made by other people — the hosts discuss it from the outside):\n${contentSummary}`
    : 'There is no source material this episode — the hosts introduce the show and chat briefly about what it covers.'

  const turns: ScriptTurn[] = []
  const covered: string[] = []

  for (let i = 0; i < outline.segments.length; i++) {
    const seg = outline.segments[i]!
    const budget = budgets[i]!
    const userPrompt = buildSegmentPrompt({
      materialBlock,
      outline, seg, index: i,
      budget,
      covered,
      tail: turns.slice(-3).map(t => formatTurn(t, hostInfos)).join('\n'),
      show, cast, isMultiHost,
    })

    const genOpts = {
      temperature: 0.8,
      num_ctx: SCRIPT_NUM_CTX,
      num_predict: Math.max(800, Math.min(3000, 400 + budget * 4)),
    }

    // One retry for a segment that errors or comes back far under budget; keep the better
    // attempt. Never abandon the remaining segments because one call misbehaved.
    let best: ScriptTurn[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await ollamaChat(model, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ], undefined, genOpts, undefined, SCRIPT_TIMEOUT_MS)
        const got = scrubTurns(parseTurns(resp.message?.content ?? '', hostInfos, !isMultiHost))
        if (countWords(got) > countWords(best)) best = got
        // Budgets are padded past the model's natural per-call emission, so "short" here
        // means genuinely broken (refusal/parse failure), not just under the padded ask.
        if (countWords(best) >= budget * 0.45) break
        if (attempt === 0) console.log(`[podcast] segment ${i + 1}/${outline.segments.length} "${seg.label}" short (${countWords(best)}/${budget} words) — retrying`)
      } catch (err) {
        if (attempt === 0) console.log(`[podcast] segment ${i + 1}/${outline.segments.length} "${seg.label}" failed (${err}) — retrying`)
        else if (!best.length && !turns.length && i === 0) throw new Error(`LLM script generation failed: ${err}`)
      }
    }

    console.log(`[podcast] segment ${i + 1}/${outline.segments.length} "${seg.label}": ${best.length} turns, ${countWords(best)}/${budget} words`)
    turns.push(...best)
    covered.push(seg.focus)
  }

  if (!turns.length) throw new Error('LLM script generation produced no usable turns across all segments')

  // The outro prompt demands a goodbye, but a weak model sometimes writes takeaway waffle
  // and stops — leaving the episode hanging mid-conversation. If no farewell landed, make
  // one dedicated micro-call for just the goodbye. Best-effort.
  if (!hasFarewell(turns)) {
    console.log('[podcast] no farewell detected — generating explicit sign-off')
    try {
      const tail = turns.slice(-3).map(t => formatTurn(t, hostInfos)).join('\n')
      const resp = await ollamaChat(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `The episode ends with:\n${tail}\n\nWrite ONLY the final sign-off: 2 to 4 short turns where ${isMultiHost ? 'the hosts' : 'the host'} thank the listener for listening to "${show.name}" and say goodbye / see you next time, in character. No new topics. Return ONLY the JSON array of these closing turns.` },
      ], undefined, { temperature: 0.7, num_ctx: SCRIPT_NUM_CTX, num_predict: 400 }, undefined, SCRIPT_TIMEOUT_MS)
      const closing = scrubTurns(parseTurns(resp.message?.content ?? '', hostInfos, false))
      if (closing.length) turns.push(...closing.slice(0, 4))
    } catch { /* an abrupt ending beats failing the episode */ }
  }

  const total = countWords(turns)
  console.log(`[podcast] script complete: ${turns.length} turns, ${total} words (target ${targetWords}, ~${Math.round(total / 165)} min)`)
  if (total < targetWords * 0.5) {
    console.warn(`[podcast] script is well under target (${total}/${targetWords} words) — check model output quality`)
  }
  return turns
}

// ── Prompt building ─────────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  show: ShowConfig,
  styleGuide: string,
  outline: EpisodeOutline,
  hostInfos: HostInfo[],
  cast: CastBrief | undefined,
  angleById: Map<string, string>,
): string {
  const isMultiHost = hostInfos.length > 1

  // Fold each host's show persona (role/background/on-air voice) into their description.
  const personaById = new Map((cast?.members ?? []).map(m => [m.id, m]))
  const hostDescriptions = hostInfos.map(h => {
    const m = personaById.get(h.id)
    let line = `- ${h.name}`
    if (m?.role) line += ` — ${m.role}`
    line += `. On-air voice: ${m?.voice || cleanPersonality(h.personality)}`
    if (m?.background) line += ` Background: ${m.background}`
    const angle = angleById.get(h.id) ?? m?.episodeAngle
    if (angle) line += ` Angle this episode: ${angle}`
    return line
  }).join('\n')

  const conversationRules = isMultiHost
    ? `HOW THE CONVERSATION SOUNDS — this is what makes it believable:
- When a host makes a point, they develop it in 2 to 4 COMPLETE sentences — real substance, not a fragment.
- The other hosts respond with short natural reactions ("Yeah.", "Wait, really?", "Huh."), follow-up questions, or pushback — then someone develops the next point.
- Alternate that rhythm: substantive point → quick reaction → build on it or disagree → next point. Do not write two long monologues in a row, and do not write ten one-liners in a row.
- FINISH EVERY THOUGHT. Never end a line mid-sentence. At most ONE interruption in this part of the episode — and if one host trails off with "...", the next line must complete or answer that exact thought.
- Occasional light imperfections make it human: an "um" before a tricky idea, a "wait, no — I mean…" self-correction, a "you know" — at most one every 4 or 5 turns, never on facts, names, or numbers.
- BANNED phrases (instant AI tells): "Absolutely!", "Exactly!", "Certainly!", "That's a great point", "Great question", "Fascinating", "As you mentioned". React like a person instead: "yeah", "right", "oh man", "hold on". Also avoid the analyst tics "it's essential to", "it's crucial to", and "I think it's important" — just say the thing plainly.
- Friendly disagreement and different takes are good — let each host's distinct voice and angle come through. A more expert host goes deeper and offers opinions; a newer one asks the questions a listener would ask.
- A host NEVER refers to themself by their own name or in the third person, and never credits a point to the person who just made it by name.
- Use the occasional analogy ("it's basically like…") to make an idea land.`
    : `Single host: ${hostInfos[0]?.name ?? 'Host'}. Warm and direct, like talking to one person. Develop each point fully in complete sentences, use the occasional analogy to make a point land, and recap briefly when moving between the major parts. An occasional "you know" or self-correction keeps it human — sparingly, never on facts.`

  return `You are a podcast script writer. You write ONE PART of an episode of "${show.name}" per request; other parts are written separately and stitched together.
${show.description ? `Show description: ${show.description}` : ''}
Style: ${show.style} — ${styleGuide}

PERSPECTIVE — THE GOLDEN RULE: The hosts are outside commentators discussing material that OTHER people made. They are NOT the people in the material and did none of the things in it. They talk ABOUT the creator in the third person — "in the video", "she shows", "apparently he…" — and NEVER use "I/we" for anything the creator did or owns. Never role-play or re-enact the material.
NO AFFILIATION: The hosts have no connection to the source material or its creators — even if the show's name references them. The creator's channel, website, Discord, or socials are never "ours", and the hosts never plug them.
NAME THE CREATOR: Refer to the creator/channel by the actual name given in the source material, naturally and often, the way real commentators do — not a flat "the creator" every time, and NEVER invent or substitute a name that isn't in the material.
STAY GROUNDED — the #1 content rule: every specific claim must come from the source material below. NEVER invent plot points, names of people, budgets, business deals, behind-the-scenes facts, or outside "historical parallels". If the material doesn't cover something, a host may briefly wonder aloud ("I'd be curious whether…") — never assert it as fact. Spend the episode on the CONTENT: the specific moments, choices, jokes, and the creator's actual takes from the material. Do NOT pad with generic talk about the creator's "mission", "ethos", "brand", or "approach" — one brief mention of that at most in the whole episode.

${formatOutlineBlock(outline)}

Hosts:
${hostDescriptions}

${conversationRules}

OUTPUT FORMAT: Return ONLY a JSON array of dialogue turns: [{"host":"<host name, exactly as listed above>","text":"<the spoken words>"}]. Spoken words only — no stage directions, no sound effects, no speaker names inside the text.`
}

function buildSegmentPrompt(opts: {
  materialBlock: string
  outline: EpisodeOutline
  seg: OutlineSegment
  index: number
  budget: number
  covered: string[]
  tail: string
  show: ShowConfig
  cast?: CastBrief
  isMultiHost: boolean
}): string {
  const { materialBlock, outline, seg, index, budget, covered, tail, show, cast, isMultiHost } = opts
  const total = outline.segments.length
  const parts: string[] = [materialBlock, '']

  parts.push(`YOUR ASSIGNMENT — write ONLY part ${index + 1} of ${total} of the episode.`)
  parts.push(`This part${seg.label ? ` ("${seg.label}")` : ''} covers: ${seg.focus}`)
  parts.push(`Write about ${budget} words of dialogue for this part — cover its material thoroughly rather than rushing.`)

  if (covered.length) {
    parts.push(`\nAlready covered earlier in the episode — do NOT repeat, re-explain, or re-introduce any of it:\n${covered.map(c => `- ${c}`).join('\n')}`)
  }

  if (tail) {
    parts.push(`\nThe episode so far ends with:\n${tail}\nContinue seamlessly from these lines: no greeting, no "welcome back", no recapping what was already said. Start with a different host than whoever spoke last.`)
  }

  if (seg.type === 'intro') {
    parts.push(`\nThis is the OPENING of the episode. The FIRST turn MUST be a spoken on-air welcome that names the show ("${show.name}") and says hi, then the hosts tee up what today's episode is about so a listener with zero context immediately gets it. Greet ONCE; the rest of the episode never greets again.`)
    if (outline.hook) parts.push(`Right after the welcome, land this hook — rephrased into something a person would actually SAY out loud, not read like written copy: ${outline.hook}`)
    const beats = castBeatsBlock(cast)
    if (beats) parts.push(beats)
  } else if (seg.type === 'outro') {
    parts.push(`\nThis is the CLOSING of the episode — it actually ENDS here. First 1-2 turns: land a final takeaway on what was discussed. Then the FINAL turns: an explicit on-air goodbye — ${isMultiHost ? 'the hosts' : 'the host'} thank the listener for listening and say goodbye / see you next time, in character. The very LAST turn must be a goodbye. Do NOT introduce new material, and do NOT propose "diving deeper", "exploring further", or continuing the discussion — the episode is over.`)
  } else {
    parts.push(`\nDo NOT wrap up, sign off, or thank the listener — the episode continues after this part. Stay on this part's focus; later parts handle the rest of the arc.`)
  }

  return parts.join('\n')
}

/** The hosts' small personal "what's new" moments — woven into the opening only. */
function castBeatsBlock(cast?: CastBrief): string {
  if (!cast) return ''
  const beatLines = cast.members.filter(m => m.beat).map(m =>
    `- ${m.name}: ${m.beat}${m.recent.length ? ` [earlier: ${m.recent.join('; ')}]` : ''}`,
  ).join('\n')
  const awayLines = cast.away.map(a => `- ${a.name} is away this episode${a.beat ? ` (${a.beat})` : ''}.`).join('\n')
  if (!beatLines && !awayLines) return ''
  return `\nPersonal color for the opening — these hosts know each other. Include AT MOST one brief, natural check-in moment (a line or two, e.g. asking how something is going and reacting, maybe a callback to an "[earlier: …]" note), then get on with the show. Keep it light — the material is the point:\n${beatLines}${awayLines ? `\nAway this episode (do NOT write any lines for them; one brief mention or tease at most):\n${awayLines}` : ''}`
}

/** Per-segment word budgets that sum to ~the episode target: intro 12%, outro 8%, body split evenly. */
function segmentBudgets(segs: OutlineSegment[], targetWords: number): number[] {
  const intro = Math.max(60, Math.round(targetWords * 0.12))
  const outro = Math.max(50, Math.round(targetWords * 0.08))
  const bodyCount = segs.filter(s => s.type === 'body').length || 1
  const body = Math.max(80, Math.round((targetWords - intro - outro) / bodyCount))
  return segs.map(s => s.type === 'intro' ? intro : s.type === 'outro' ? outro : body)
}

/** "Name: line" rendering of a turn, for continuity tails. */
function formatTurn(t: ScriptTurn, hostInfos: HostInfo[]): string {
  return `${hostInfos.find(h => h.id === t.host)?.name ?? t.host}: ${t.text}`
}

/**
 * Companion characters' personality prompts are written for 1:1 chat ("You are Loki, the
 * user's upbeat companion…"). When no on-air cast voice exists yet, strip the framing so
 * the script model gets traits, not a second-person companion briefing.
 */
function cleanPersonality(personality: string): string {
  return personality
    .replace(/^you are [^,.]*[,.]\s*/i, '')
    .replace(/\bthe user's\b/gi, 'people’s')
    .replace(/\bthe user\b/gi, 'people')
    .slice(0, 300)
}

// Turn-initial AI affirmations the model still leaks despite the prompt ban. Swapped for
// natural openers deterministically — safer than another LLM pass. "(?!\s+not\b)" spares
// legitimate uses like "Absolutely not".
const AI_AFFIRMATION = /^(?:exactly|absolutely|precisely|certainly|indeed)(?!\s+not\b)[.,!]?\s*/i
const NATURAL_OPENERS = ['Yeah — ', 'Right — ', 'Oh totally — ']

/** True when the script already lands an on-air goodbye near the end. */
function hasFarewell(turns: ScriptTurn[]): boolean {
  const FAREWELL = /thanks? (?:so much )?for (?:listening|tuning|joining)|see you (?:next|soon|then)|until next time|catch you (?:next|later)|that'?s (?:it|all) for (?:today|this|now)|good\s?bye|signing off|we'?ll be back next/i
  return turns.slice(-4).some(t => FAREWELL.test(t.text))
}

/** Drop turns that break the outside-commentator illusion (claimed channels/URLs/sub plugs),
 *  swap turn-initial AI affirmations for natural reactions, and drop consecutive duplicates
 *  (local models occasionally emit the same turn twice back-to-back). */
function scrubTurns(turns: ScriptTurn[]): ScriptTurn[] {
  let openerIdx = 0
  const out: ScriptTurn[] = []
  let prevKey = ''
  for (const t of turns) {
    if (IDENTITY_LEAK.test(t.text)) {
      console.log(`[podcast] scrubbed identity-leak turn: "${t.text.slice(0, 80)}"`)
      continue
    }
    const key = t.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (key && key === prevKey) {
      console.log(`[podcast] scrubbed duplicate turn: "${t.text.slice(0, 80)}"`)
      continue
    }
    prevKey = key
    let text = t.text
    if (AI_AFFIRMATION.test(text)) {
      const rest = text.replace(AI_AFFIRMATION, '')
      text = rest ? NATURAL_OPENERS[openerIdx++ % NATURAL_OPENERS.length]! + rest : 'Yeah.'
    }
    // Collapse stray punctuation runs local models emit ("Yeah., right" → "Yeah, right").
    text = text.replace(/\.\s*,/g, ',').replace(/([!?]),/g, '$1').replace(/([.!?])\1+/g, '$1')
    out.push({ ...t, text })
  }
  return out
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an LLM response into clean, voice-ready script turns.
 *
 * Local models are unreliable JSON emitters: they wrap output in ``` fences, add trailing
 * commas, leave strings unescaped, or ignore the format and write a "Name: line" screenplay.
 * We recover structure through several layers and only ever voice prose. With allowRawFallback
 * (single-host shows) a genuinely plain reply still becomes one turn; multi-host passes false
 * so filler is dropped rather than voiced by the wrong host.
 */
function parseTurns(raw: string, hostInfos: HostInfo[], allowRawFallback = true): ScriptTurn[] {
  const cleaned = raw.replace(/```[a-z]*\n?/gi, '').trim()

  // 1. Strict JSON array (the happy path).
  const arr = cleaned.match(/\[[\s\S]*\]/)?.[0]
  if (arr) {
    const direct = tryParseJsonArray(arr)
    if (direct.length) return normalizeHosts(direct, hostInfos)
    // 2. Repair the most common local-model breakage (trailing commas) and retry.
    const repaired = tryParseJsonArray(arr.replace(/,\s*([}\]])/g, '$1'))
    if (repaired.length) return normalizeHosts(repaired, hostInfos)
  }

  // 3. Salvage host/text pairs by regex from broken-but-recognizable JSON. Keeps the field
  //    KEYS out of the audio even when the structure won't parse.
  const pairs = extractJsonPairs(cleaned)
  if (pairs.length) return normalizeHosts(pairs, hostInfos)

  // 4. "Name: dialogue" screenplay form (model ignored the JSON instruction).
  const lines = parseSpeakerLines(cleaned, hostInfos)
  if (lines.length) return normalizeHosts(lines, hostInfos)

  // 5. Last resort: a plain-prose reply becomes one spoken turn — but only if it isn't just
  //    unparseable JSON, which we must never read aloud.
  if (!allowRawFallback) return []
  if (/[[{]|"host"|"text"/i.test(cleaned)) return []
  const text = cleaned.slice(0, 2000).trim()
  return text ? normalizeHosts([{ host: '', text }], hostInfos) : []
}

/** Parse a JSON array of turns, coercing/validating loosely. Returns [] on any failure. */
function tryParseJsonArray(s: string): { host: string; text: string }[] {
  try {
    const parsed = JSON.parse(s) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map(t => ({ host: String(t.host ?? ''), text: String(t.text ?? '').trim() }))
      .filter(t => t.text)
  } catch { return [] }
}

/** Pull {host,text} pairs out of JSON-ish text even when JSON.parse rejects it. */
function extractJsonPairs(text: string): { host: string; text: string }[] {
  const out: { host: string; text: string }[] = []
  for (const obj of text.match(/\{[^{}]*\}/g) ?? []) {
    const host = obj.match(/"host"\s*:\s*"([^"]*)"/i)?.[1]
    const body = obj.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/i)?.[1]
    if (host == null || body == null) continue
    const text = unescapeJson(body).trim()
    if (text) out.push({ host, text })
  }
  return out
}

function unescapeJson(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["\\/])/g, '$1')
}

const SPEAKER_LINE = /^\s*([A-Za-z][\w .'-]{0,30}?)\s*:\s*(.*)$/
/** Treat a "Label:" prefix as a speaker only when it names a known host or a generic role —
 *  so ordinary prose ("Breaking news: …") isn't mistaken for a speaker turn. */
function isSpeakerLabel(label: string, hostInfos: HostInfo[]): boolean {
  const l = label.trim().toLowerCase()
  if (hostInfos.some(h => h.id.toLowerCase() === l || h.name.toLowerCase() === l)) return true
  return /^(host|co-?host|guest|narrator|speaker)\b/.test(l)
}

/** Parse a "Name: dialogue" screenplay into turns; unlabelled lines extend the prior turn. */
function parseSpeakerLines(text: string, hostInfos: HostInfo[]): { host: string; text: string }[] {
  const turns: { host: string; text: string }[] = []
  let cur: { host: string; text: string } | null = null
  let labelled = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const m = line.match(SPEAKER_LINE)
    if (m && isSpeakerLabel(m[1]!, hostInfos)) {
      labelled = true
      if (cur?.text.trim()) turns.push(cur)
      cur = { host: m[1]!, text: m[2] ?? '' }
    } else if (cur) {
      cur.text += ' ' + line
    } else {
      cur = { host: '', text: line }
    }
  }
  if (cur?.text.trim()) turns.push(cur)
  // Only a genuinely labelled screenplay counts; bare prose belongs to the raw fallback.
  return labelled ? turns.filter(t => t.text.trim()) : []
}

/**
 * Canonicalize each turn's host to a known character id. The prompt asks for host NAMES
 * (far more reliable than UUIDs for a local model); match by name or id, and map any
 * remaining distinct labels onto the real hosts in round-robin so speakers stay distinct.
 */
function normalizeHosts(turns: { host: string; text: string }[], hostInfos: HostInfo[]): ScriptTurn[] {
  const fallback = hostInfos[0]?.id ?? 'default'
  const labelToId = new Map<string, string>()
  let nextUnknown = 0
  const resolve = (rawHost: string): string => {
    const want = rawHost.trim().toLowerCase()
    if (!want) return fallback
    const exact = hostInfos.find(h => h.id.toLowerCase() === want || h.name.toLowerCase() === want)
    if (exact) return exact.id
    if (!labelToId.has(want)) {
      labelToId.set(want, hostInfos[nextUnknown % Math.max(1, hostInfos.length)]?.id ?? fallback)
      nextUnknown++
    }
    return labelToId.get(want)!
  }
  return turns.map(t => ({ host: resolve(t.host), text: t.text.trim() })).filter(t => t.text)
}
