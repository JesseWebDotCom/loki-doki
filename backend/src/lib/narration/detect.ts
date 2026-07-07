// Speaker detection for the multi-voice narration engine. Layered, cheapest-first,
// and always produces something — mirrors the robustness ladder in
// backend/src/lib/podcast/script.ts::parseTurns(), but for arbitrary prose/scripts
// instead of LLM-generated podcast dialogue.
//
// Plain prose with no dialogue (the common case) never reaches the LLM pass —
// looksLikeDialogueProse() bails out early so single-voice narration (e.g. Bookmarks
// "Listen") keeps its existing near-zero-latency behavior.

import { getModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { extractJsonPairs } from '@/lib/textRepair'
import type { RawTurn, DetectionResult, NormalizedTurn } from './types'

const MAX_SPEAKERS = 8
const WINDOW_CHARS = 1800
const DETECT_TIMEOUT_MS = 60_000

// ── 1. Script-format heuristic (no LLM) ─────────────────────────────────────────

const SPEAKER_LINE = /^\s*([A-Za-z][\w .'-]{0,30}?)\s*:\s*(.*)$/

/** If most non-blank lines are "Name: text" and name at least 2 distinct speakers,
 *  parse the whole document as a screenplay/transcript directly. */
function tryScriptHeuristic(text: string): RawTurn[] | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 4) return null

  let labelled = 0
  const labels = new Set<string>()
  for (const line of lines) {
    const m = line.match(SPEAKER_LINE)
    if (m) { labelled++; labels.add(m[1]!.trim().toLowerCase()) }
  }
  if (labelled < lines.length * 0.6 || labels.size < 2) return null

  const turns: RawTurn[] = []
  let cur: RawTurn | null = null
  for (const line of lines) {
    const m = line.match(SPEAKER_LINE)
    if (m) {
      if (cur?.text.trim()) turns.push(cur)
      cur = { speaker: m[1]!.trim(), text: m[2] ?? '' }
    } else if (cur) {
      cur.text += ' ' + line
    }
  }
  if (cur?.text.trim()) turns.push(cur)
  return turns.filter(t => t.text.trim())
}

// ── 2. LLM pass for prose with embedded dialogue ────────────────────────────────

const DETECT_SYSTEM = `You tag a passage of text with who is speaking each part. "Narrator" is any descriptive or narrative text that isn't spoken dialogue. A character's name is used for dialogue attributed to them (e.g. "she said", "Tom replied", a line inside quotation marks near their name). Preserve the original wording of every part EXACTLY — never summarize, paraphrase, or omit any of it. Return ONLY a JSON array: [{"speaker":"Narrator","text":"..."},{"speaker":"Tom","text":"..."}]`

function chunkByParagraph(text: string, maxChars: number): string[] {
  const paras = text.split(/\n{2,}/)
  const windows: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length > maxChars) {
      windows.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur) windows.push(cur)
  return windows
}

function tryParseJsonArray(s: string): RawTurn[] {
  try {
    const parsed = JSON.parse(s) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map(t => ({ speaker: (String(t.speaker ?? 'Narrator').trim() || 'Narrator'), text: String(t.text ?? '').trim() }))
      .filter(t => t.text)
  } catch { return [] }
}

function parseDetectionResponse(raw: string): RawTurn[] {
  const cleaned = raw.replace(/```[a-z]*\n?/gi, '').trim()
  const arr = cleaned.match(/\[[\s\S]*\]/)?.[0]
  if (arr) {
    const direct = tryParseJsonArray(arr)
    if (direct.length) return direct
    const repaired = tryParseJsonArray(arr.replace(/,\s*([}\]])/g, '$1'))
    if (repaired.length) return repaired
  }
  const pairs = extractJsonPairs(cleaned, 'speaker', 'text')
  if (pairs.length) return pairs.map(p => ({ speaker: p.speaker || 'Narrator', text: p.text! }))
  return []
}

/** Windowed LLM tagging pass, carrying known speakers forward for pronoun continuity.
 *  Returns null (never throws) if any window fails to parse — callers fall back. */
async function detectViaLlm(text: string): Promise<RawTurn[] | null> {
  const windows = chunkByParagraph(text, WINDOW_CHARS)
  const model = await getModel()
  const turns: RawTurn[] = []
  const knownSpeakers = new Set<string>()

  for (const window of windows) {
    const known = knownSpeakers.size ? `Known speakers so far, for continuity: ${[...knownSpeakers].join(', ')}.\n` : ''
    const prompt = `${known}PASSAGE:\n${window}`
    let parsed: RawTurn[]
    try {
      const resp = await ollamaChat(
        model,
        [
          { role: 'system', content: DETECT_SYSTEM },
          { role: 'user', content: prompt },
        ],
        undefined,
        // num_ctx matches the chat default — this runs on the MAIN chat model, and a
        // 4096 call forces a full runner reload + total KV loss, so the user's next
        // chat turn pays a second multi-second reload back to 8192.
        { temperature: 0.2, num_ctx: 8192, num_predict: Math.max(800, Math.ceil(window.length / 2)) },
        undefined,
        DETECT_TIMEOUT_MS,
      )
      parsed = parseDetectionResponse(resp.message?.content ?? '')
    } catch {
      return null
    }
    if (!parsed.length) return null
    for (const t of parsed) {
      turns.push(t)
      if (t.speaker && t.speaker.toLowerCase() !== 'narrator') knownSpeakers.add(t.speaker)
    }
  }
  return turns
}

// ── 3. Regex quote-attribution fallback (LLM unavailable/failed) ───────────────

const SPEECH_VERB = '(?:said|asked|replied|shouted|whispered|muttered|answered|exclaimed|cried|added|called|murmured)'
const QUOTE_ATTR_RE = new RegExp(
  `(?:"([^"]{2,400})"\\s*,?\\s*([A-Z][\\w'.-]{0,30})\\s+${SPEECH_VERB}\\b)` +
  `|(?:([A-Z][\\w'.-]{0,30})\\s+${SPEECH_VERB}[,:]?\\s*"([^"]{2,400})")`,
  'g',
)

/** Splits text into Narrator/speaker turns by matching "…said Name" / "Name said …"
 *  patterns; unattributed stretches stay Narrator. Always produces something. */
function regexQuoteFallback(text: string): RawTurn[] {
  const turns: RawTurn[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  QUOTE_ATTR_RE.lastIndex = 0
  while ((m = QUOTE_ATTR_RE.exec(text))) {
    if (m.index > lastIndex) {
      const narrated = text.slice(lastIndex, m.index).trim()
      if (narrated) turns.push({ speaker: 'Narrator', text: narrated })
    }
    const quote = m[1] ?? m[4]
    const name = m[2] ?? m[3]
    if (quote && name) turns.push({ speaker: name.trim(), text: quote.trim() })
    lastIndex = QUOTE_ATTR_RE.lastIndex
  }
  const rest = text.slice(lastIndex).trim()
  if (rest) turns.push({ speaker: 'Narrator', text: rest })
  return turns
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Cheap gate: is it even worth trying to detect dialogue? Plain prose (no quotes)
 *  skips straight to the single-narrator fallback with zero added latency. */
function looksLikeDialogueProse(text: string): boolean {
  return (text.match(/["“]/g) ?? []).length >= 2
}

export async function detectTurns(text: string): Promise<DetectionResult> {
  const trimmed = text.trim()
  if (!trimmed) return { turns: [], method: 'single-narrator' }

  const scripted = tryScriptHeuristic(trimmed)
  if (scripted?.length) return { turns: scripted, method: 'script-heuristic' }

  if (looksLikeDialogueProse(trimmed)) {
    const llmTurns = await detectViaLlm(trimmed).catch(() => null)
    if (llmTurns?.length) return { turns: llmTurns, method: 'llm' }

    const regexTurns = regexQuoteFallback(trimmed)
    if (regexTurns.some(t => t.speaker.toLowerCase() !== 'narrator')) {
      return { turns: regexTurns, method: 'regex-fallback' }
    }
  }

  return { turns: [{ speaker: 'Narrator', text: trimmed }], method: 'single-narrator' }
}

// ── Canonicalization ─────────────────────────────────────────────────────────

/** Canonicalize raw speaker labels into stable keys, folding overflow past
 *  MAX_SPEAKERS distinct (non-narrator) speakers into "Other". */
export function normalizeSpeakers(rawTurns: RawTurn[]): {
  speakers: { normalizedKey: string; label: string; isNarrator: boolean }[]
  turns: NormalizedTurn[]
} {
  const firstSeen: string[] = []
  const labelByKey = new Map<string, string>()

  const keyOf = (rawSpeaker: string): string => {
    const raw = (rawSpeaker || 'Narrator').trim() || 'Narrator'
    const key = raw.toLowerCase().replace(/\s+/g, ' ')
    if (!labelByKey.has(key)) {
      labelByKey.set(key, key === 'narrator' ? 'Narrator' : raw)
      firstSeen.push(key)
    }
    return key
  }

  const rawKeys = rawTurns.map(t => keyOf(t.speaker))

  const nonNarrator = firstSeen.filter(k => k !== 'narrator')
  const overflow = new Set(nonNarrator.slice(MAX_SPEAKERS))
  const remap = (key: string) => (overflow.has(key) ? 'other' : key)
  if (overflow.size) labelByKey.set('other', 'Other')

  const finalKeys = firstSeen.map(remap).filter((k, i, arr) => arr.indexOf(k) === i)
  const speakers = finalKeys.map(key => ({
    normalizedKey: key,
    label: labelByKey.get(key) ?? key,
    isNarrator: key === 'narrator',
  }))

  const turns: NormalizedTurn[] = rawTurns
    .map((t, i) => ({ normalizedKey: remap(rawKeys[i]!), text: t.text.trim() }))
    .filter(t => t.text)

  return { speakers, turns }
}
