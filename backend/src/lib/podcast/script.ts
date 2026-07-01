// LLM script generation for podcast episodes.
// Input: show config + collected segment content
// Output: ordered array of { host, text } turns

import { getModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import type { ShowConfig, ScriptTurn, SegmentContent, CastBrief } from './types'
import { generateEpisodeOutline, formatOutlineBlock } from './outline'
import { applyDisfluencyPass } from './disfluency'
import { generateEpisodeAngles } from './persona'

// Per-style direction plus an explicit total word target. LLMs hit a word count far
// more reliably than a "minutes" hint, and the target is what keeps episodes from
// coming out a fraction of their intended length. ~165 spoken words/min at our 1.15x
// playback floor, so targetWords ≈ minutes × 165.
const STYLE_INSTRUCTIONS: Record<string, { guide: string; targetWords: number }> = {
  'recap':       { guide: 'Conversational recap — summarize what happened, hit the highlights, and react to them. Friendly and informative.', targetWords: 1100 },
  'in-depth':    { guide: 'Thorough and analytical — explore context, implications, and the "why it matters" behind each item. Go deep on the details.', targetWords: 2000 },
  'roundtable':  { guide: 'Hosts debate and discuss from different perspectives. Let them agree, disagree, and riff off each other at length.', targetWords: 1850 },
  'interview':   { guide: 'Q&A format — the first host asks probing questions, the second answers as an expert and goes deep on each one.', targetWords: 1750 },
  'briefing':    { guide: 'Professional news-anchor style. Factual, direct, and well-paced through every story.', targetWords: 900 },
  'story':       { guide: 'Narrative storytelling — vivid language, a clear arc, scene by scene.', targetWords: 1400 },
}

/** Count spoken words across all turns (used to detect under-length scripts). */
function countWords(turns: { text: string }[]): number {
  return turns.reduce((n, t) => n + (t.text.trim().match(/\S+/g)?.length ?? 0), 0)
}

// Context window for script generation. The default Ollama context (2048) is the main
// reason episodes came out tiny: a 12k-char transcript fills it on its own, leaving no
// room to actually generate. 8192 fits the transcript input AND a long script.
const SCRIPT_NUM_CTX = 8192

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

  // Outline + angles are independent — run in parallel to avoid adding two serial round-trips
  // before the main (large) model call which already needs its own VRAM load headroom.
  const [outline, episodeAngles] = await Promise.all([
    generateEpisodeOutline(contentSummary).catch(() => null),
    cast?.members?.length
      ? generateEpisodeAngles(cast.members, contentSummary).catch(() => [])
      : Promise.resolve([]),
  ])
  const angleById = new Map(episodeAngles.map(a => [a.id, a.angle]))

  // Fold each host's show persona (role/background/hobbies) into their description.
  const personaById = new Map((cast?.members ?? []).map(m => [m.id, m]))
  const hostDescriptions = hostInfos.map(h => {
    const m = personaById.get(h.id)
    let line = `- ${h.name} (id: ${h.id})`
    if (m?.role) line += ` — ${m.role}`
    line += `. Personality: ${h.personality}`
    if (m?.background) line += ` Background: ${m.background}`
    const angle = angleById.get(h.id) ?? m?.episodeAngle
    if (angle) line += ` Angle this episode: ${angle}`
    if (m?.hobbies.length) line += ` Hobbies: ${m.hobbies.join(', ')}.`
    return line
  }).join('\n')

  // This episode's small personal "what's new" beats (+ a little prior history so the
  // hosts can recall/tease each other) and anyone sitting it out.
  const beatLines = (cast?.members ?? []).filter(m => m.beat).map(m =>
    `- ${m.name}: ${m.beat}${m.recent.length ? ` [earlier: ${m.recent.join('; ')}]` : ''}`,
  ).join('\n')
  const awayLines = (cast?.away ?? []).map(a => `- ${a.name} is away this episode${a.beat ? ` (${a.beat})` : ''}.`).join('\n')
  const castSection = (beatLines || awayLines)
    ? `\nWHAT'S NEW WITH THE HOSTS THIS EPISODE — these hosts KNOW each other, but keep this VERY LIGHT: AT MOST TWO short personal moments in the ENTIRE episode (e.g. a brief check-in near the top and, at most, one callback or tease later) — not in every exchange, and never a back-and-forth that runs more than a couple of lines. When it does happen they talk TO each other: ask how things are going, react, gently tease, and CALL BACK to each other's earlier moments (the "[earlier: …]" notes — e.g. "Wait, didn't you say you were starting a garden?"). It should feel like friends who've done this show a while. Everything else stays on the material; all personal chatter combined must stay well under ~10% of the episode.\n${beatLines}${awayLines ? `\nAway this episode (do NOT write any lines for them; one brief mention or tease at most):\n${awayLines}` : ''}\n`
    : ''

  const isMultiHost = hostInfos.length > 1
  const hostList = hostInfos.map(h => h.name).join(', ')

  const outlineBlock = outline ? `\n${formatOutlineBlock(outline)}\n` : ''

  const systemPrompt = `You are a podcast script writer. Write a podcast episode script for "${show.name}".
${show.description ? `Show description: ${show.description}` : ''}

Style: ${show.style}
Instructions: ${style.guide}

PERSPECTIVE — READ CAREFULLY: The hosts are third-party commentators discussing source material that OTHER people made. They are NOT the people in that material and did NOT do any of the things described in it. The hosts talk ABOUT the creator and the video from the outside, in the third person: refer to the creator by name, say "in the video", "they show", "the creator explains", "apparently he…". Every action in the material was done by the creator, not the hosts — always attribute it to them, NEVER claim it as the hosts' own ("we renovated the studio") and NEVER use "I/we" for the creator's actions. NEVER role-play, re-enact, or narrate the content as if it is happening to the hosts — they are outside observers reacting to, analyzing, and riffing on it.

NAME THE CREATOR: The material says who made it (a channel/creator name). Use that ACTUAL name naturally and often, the way real commentators do — e.g. "The thing I love about Jakkuh is they…", "MrWhosTheBoss always seems to…", "what's interesting about how they did this…". Don't fall back to a flat "the creator" every time; weave the real name in throughout, especially when opening the episode and when transitioning between the major beats.

STRUCTURE — IMPORTANT: Each piece of source material comes with an overall premise and an ordered list of its major beats. Build the episode to FOLLOW that arc and stay on the BIG PICTURE. Open by setting up what it's actually about at a high level, so a listener with zero prior context immediately understands it; then move through the major beats IN ORDER (e.g. overview → it arrives / first impressions → testing → improvements → final thoughts), bringing in specific details only to illustrate each major part. Do NOT open on or dwell in small isolated details (a stray part, a passing remark) before the big picture is established, and do not get lost in minutiae — always keep the through-line of the overall story.
${outlineBlock}
LENGTH: This is a full ${targetMinutes}-minute episode. Write roughly ${targetWords} words of spoken dialogue in total — this is a firm target, not a maximum. Work through ALL of the material below thoroughly; spend real time on each item rather than rushing. Do not wrap up or sign off until you have covered everything and hit the length.

Hosts:
${hostDescriptions}
Let each host's distinct personality and viewpoint come through, and have them engage with the material from their OWN angle — a more expert host goes deeper and offers opinions; a newer one asks questions and reacts; an everyperson keeps it grounded and relatable. Friendly disagreement and different takes are good.
${castSection}
Format your output as a JSON array of turns, each with "host" (the character id, exactly as listed above) and "text" (what they say).
${isMultiHost
  ? `Hosts: ${hostList}. Write a real back-and-forth conversation, NOT alternating monologues:
- Each line of dialogue should be no more than 100 characters (roughly 5-8 seconds of audio). Long explanations must be broken into multiple shorter turns with reactions between them.
- Keep individual turns short (1 to 3 sentences) so they volley quickly — but write MANY turns to reach the length target.
- Use natural interjections: "Yeah", "Right", "Oh totally", "Wait, what?", "No way", "Hmm", "Hold on", "Huh".
- AVOID these LLM defaults — they kill naturalness instantly: "Absolutely!", "Exactly!", "Certainly!", "That's a great point", "Great question", "Fascinating", "As you mentioned". Use "yeah", "right", "oh totally", "wait" instead.
- Hosts react to and build on each other, ask each other questions, and push back or disagree sometimes.
- Occasionally one host cuts in or finishes the other's thought: trail off the first turn with "..." and have the other jump in.
- Vary who leads; write the occasional laugh or aside as words (e.g. "ha", "okay okay").
- Make ideas land: use the occasional analogy ("it's basically like…") and rhetorical question to set up a point.
- Bridge between beats with quick recaps ("so they've got it running, but then…") so the through-line stays clear.

EXAMPLE — natural dialogue vs. scripted (write like the natural version):
BAD (scripted — do not write like this):
  Host A: Can you explain how that works?
  Host B: Certainly! That's a great question. Essentially, what happens is the system processes each input sequentially and then generates a corresponding output based on the trained parameters.
  Host A: That's fascinating. So what you're saying is it learns from examples?

GOOD (natural — write like this):
  Host A: So wait — it just... figures it out on its own?
  Host B: Yeah, sort of. It sees enough examples and then—
  Host A: Right, right.
  Host B: —it starts picking up on patterns. Like, you don't program the rules explicitly.
  Host A: Huh. That's kind of wild when you think about it.`
  : `Single host: ${hostInfos[0]?.name ?? 'Host'}. Warm and direct, like talking to one person. Develop each point fully, use the occasional analogy to make a point land, and recap briefly when moving between the major beats.`}
Do not include stage directions, sound effects, or speaker names inside the text — only spoken words. Do not role-play or act out scenes; speak only as podcast hosts commenting on the material from the outside.
Return ONLY the JSON array, no other text.`

  const userPrompt = `Here is the source material to discuss in this episode — it was made by other people. React to it and analyze it as commentators; do NOT act it out or speak as if you did the things in it:\n\n${contentSummary || '(No content available — create a brief introduction to the show instead.)'}`

  // First pass greets the audience once (branded open). Continuation passes reuse the plain
  // userPrompt and are told to continue seamlessly, so the welcome isn't repeated.
  const openingInstruction = `Open the episode with a brief, natural on-air welcome — name the show ("${show.name}"), say hi, and tee up what today's episode is about — then get straight into it. Greet ONCE, at the very top only.`

  const model = await getModel()
  const genOpts = { temperature: 0.8, num_ctx: SCRIPT_NUM_CTX, num_predict: 4096 }
  // Podcast generation involves many sequential LLM calls (main gen + up to 7 expansions +
  // critique + sign-off). Pre-generation calls (outline, angles, gap detection) use the fast
  // model, which may have evicted the main model from VRAM. Give each main-model call 5 min
  // so a cold VRAM load doesn't trigger the default 120s timeout.
  const SCRIPT_TIMEOUT_MS = 5 * 60_000
  let raw = ''
  try {
    const resp = await ollamaChat(model, [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `${openingInstruction}\n\n${userPrompt}` },
    ], undefined, genOpts, undefined, SCRIPT_TIMEOUT_MS)
    raw = resp.message?.content ?? ''
  } catch (err) {
    throw new Error(`LLM script generation failed: ${err}`)
  }

  let turns = parseTurns(raw, hostInfos)

  // Local models reliably emit only a bounded chunk per call and stop well short of the
  // requested length. One continuation usually isn't enough, so keep asking for more —
  // appending each batch — until we clear ~85% of target, a pass stops making real
  // progress, or we hit the cap. Far more reliable than re-rolling and hoping for longer.
  const MAX_EXPANSIONS = 7
  for (let pass = 0; pass < MAX_EXPANSIONS && countWords(turns) < targetWords * 0.85; pass++) {
    const before = countWords(turns)
    try {
      // Feed back the tail of the conversation so the model continues coherently without
      // re-sending (and risking truncation of) the whole growing transcript.
      const tail = turns.slice(-12).map(t => `${hostInfos.find(h => h.id === t.host)?.name ?? t.host}: ${t.text}`).join('\n')
      const remaining = Math.max(150, targetWords - before)
      const resp = await ollamaChat(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
        { role: 'user', content: `The conversation so far ends with:\n${tail.slice(-4000)}\n\nIt's still too short — it needs about ${remaining} more words to reach a full ${targetMinutes}-minute episode. Continue the SAME conversation naturally from where it left off: go deeper on the material, add reactions, tangents, examples, and follow-up questions. Begin with a host DIFFERENT from whoever spoke last above, and make it seamless — do NOT greet again, do NOT re-introduce the show, and never use meta phrases like "where we left off", "welcome back", or "after the break". Do NOT repeat anything already said and do NOT wrap up or sign off yet. Return ONLY a JSON array of the additional turns to append (same {"host","text"} format).` },
      ], undefined, genOpts, undefined, SCRIPT_TIMEOUT_MS)
      const extra = parseTurns(resp.message?.content ?? '', hostInfos, false)
      if (extra.length) turns = [...turns, ...extra]
    } catch { break /* best-effort: keep what we have */ }
    // Diminishing returns — a pass that barely added anything won't be rescued by another.
    if (countWords(turns) - before < 60) break
  }

  // Critique pass — rewrite the opening (first 20 turns) to fix the most common AI-script
  // problems: formal affirmations, monologue chunks, missing backchannels, and flat openers.
  // Runs on the fully-expanded body so the editor has the whole episode for context.
  // Best-effort: any parse failure keeps the originals.
  if (turns.length > 4 && isMultiHost) {
    try {
      const OPENER_COUNT = Math.min(20, turns.length)
      const openingTurns = turns.slice(0, OPENER_COUNT)
      const openingText = openingTurns
        .map(t => `${hostInfos.find(h => h.id === t.host)?.name ?? t.host}: ${t.text}`)
        .join('\n')
      const hookLine = outline?.hook ? `\nThe intended opening hook was: "${outline.hook}"\n` : ''
      const critiqueResp = await ollamaChat(model, [
        {
          role: 'system',
          content:
            'You are an award-winning podcast script editor. An AI-generated script has been handed to you. ' +
            'Your job is to rewrite the FIRST portion so it sounds like two real people talking — not an AI reciting bullet points.\n\n' +
            'MUST FIX:\n' +
            '- Remove any turn containing "Great question", "That\'s a fascinating point", "Let me explain", ' +
            '"As you mentioned", "Certainly", "Absolutely", "Exactly" — replace with a direct reaction or follow-on\n' +
            '- Break any turn longer than 3 sentences into two shorter turns with an interjection between them\n' +
            '- Add 2-3 backchannel responses: a standalone "Yeah.", "Right.", "Hmm.", "Oh wow." where one host ' +
            'is explaining and the other would naturally react mid-explanation\n' +
            '- If the opening does not match the intended hook, revise it to open with that hook naturally\n\n' +
            'DO NOT:\n' +
            '- Change factual content about the source material\n' +
            '- Restructure the overall order\n' +
            '- Re-introduce the show or re-greet listeners\n' +
            '- Add "um" or "uh" — handled separately\n\n' +
            `Hosts: ${hostList} (use their names in the JSON "host" field exactly as shown)\n` +
            'Return ONLY a JSON array of the improved turns in {"host","text"} format.',
        },
        {
          role: 'user',
          content: `${hookLine}Opening turns to improve:\n${openingText}`,
        },
      ], undefined, { temperature: 0.7, num_ctx: SCRIPT_NUM_CTX, num_predict: 2000 }, undefined, SCRIPT_TIMEOUT_MS)

      const improved = parseTurns(critiqueResp.message?.content ?? '', hostInfos, false)
      if (improved.length >= OPENER_COUNT) {
        turns = [...improved, ...turns.slice(OPENER_COUNT)]
      }
    } catch { /* best-effort: keep originals */ }
  }

  // Sign-off. The expansion passes forbid wrapping up (so the episode doesn't end early),
  // which left episodes just stopping mid-conversation. Once the body is done, add a short,
  // natural closing so it actually lands an ending.
  if (turns.length) {
    try {
      const tail = turns.slice(-8).map(t => `${hostInfos.find(h => h.id === t.host)?.name ?? t.host}: ${t.text}`).join('\n')
      const resp = await ollamaChat(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
        { role: 'user', content: `The conversation so far ends with:\n${tail.slice(-3000)}\n\nNow write ONLY the CLOSING of this episode of "${show.name}" — a short, natural sign-off of about 3 to 6 quick turns: briefly land a final takeaway on what was discussed, then ${isMultiHost ? 'the hosts' : 'the host'} thank the listener for listening and tease coming back next time, in character. Wrap it up cleanly and do NOT introduce new material. Return ONLY a JSON array of the closing turns to append (same {"host","text"} format).` },
      ], undefined, genOpts, undefined, SCRIPT_TIMEOUT_MS)
      const closing = parseTurns(resp.message?.content ?? '', hostInfos, false)
      if (closing.length) turns = [...turns, ...closing]
    } catch { /* best-effort: a missing sign-off beats failing the episode */ }
  }

  // Disfluency pass — adds natural spoken-word imperfections as a dedicated final step.
  // Separate from generation because asking one model to write coherent content AND add
  // imperfections simultaneously produces uniform um-spam or nothing. Skips sign-off turns.
  if (isMultiHost && turns.length > 6) {
    turns = await applyDisfluencyPass(turns, hostInfos).catch(() => turns)
  }

  return turns
}

/**
 * Parse an LLM response into clean, voice-ready script turns.
 *
 * Local models are unreliable JSON emitters: they wrap output in ``` fences, add trailing
 * commas, leave strings unescaped, or ignore the format and write a "Name: line" screenplay.
 * The old code JSON.parse'd once and, on any failure, dumped the ENTIRE raw reply — literal
 * `"host":`/`"text":` keys and all — into a single spoken turn. That's why episodes read the
 * words "host" and "text" aloud, stuttered through the JSON punctuation, and used one voice
 * (one giant turn → one host). We now recover structure through several layers and only ever
 * voice prose. With allowRawFallback (first pass) a genuinely plain reply still becomes one
 * turn; the continuation pass passes false so filler is dropped rather than appended.
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
 * Canonicalize each turn's host to a known character id. Local models routinely put the
 * host's NAME (or "Host", "Speaker 2", …) in the field instead of the id — that miss made
 * every turn fall back to one default voice. Match by id or name; map any remaining distinct
 * labels onto the real hosts in round-robin so multiple speakers stay distinct.
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
