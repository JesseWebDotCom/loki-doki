// LLM lyric translation + romanized pronunciation, cached per (track, language) in
// lyric_translations so a song is only ever translated once for the household.
//
// Uses ollamaChat with a native JSON-schema `format` instead of structuredCall: the
// structuredCall system prompt demands English-only output, which is exactly wrong for
// a translation task. Lines are translated in small batches so a local model keeps
// line-to-line pairing reliable on long songs.

import { createHash } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { lyricTranslations } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'

export interface TranslatedLine {
  t: string           // the line translated into the target language
  r: string | null    // romanized pronunciation of the ORIGINAL line (non-Latin sources only)
}

// Language menu offered by the frontend. Codes are stable cache keys; labels are what
// the model is asked for.
export const LYRIC_LANGS: Record<string, string> = {
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  sv: 'Swedish',
  pl: 'Polish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
  hi: 'Hindi',
  ar: 'Arabic',
  vi: 'Vietnamese',
  tl: 'Tagalog',
  en: 'English',
}

const MAX_LINES = 200
const MAX_LINE_CHARS = 200
const BATCH_SIZE = 18

// Non-Latin script ranges (Greek, Cyrillic, Armenian, Hebrew, Arabic, Devanagari and
// other Indic scripts, Thai, Hangul, Kana, CJK). A hit means the line benefits from a
// romanized pronunciation guide.
const NON_LATIN_RE = /[Ͱ-ϿЀ-ӿ԰-֏֐-׿؀-ۿऀ-෿฀-๿ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/

export function hasNonLatinScript(s: string): boolean {
  return NON_LATIN_RE.test(s)
}

function normalizeTrackKey(artist: string, title: string): string {
  return `${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`
}

function sourceHashOf(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

// Ollama native structured-output schema: one entry per input line, in order.
const FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { t: { type: 'string' }, r: { type: 'string' } },
        required: ['t', 'r'],
      },
    },
  },
  required: ['lines'],
} as const

async function translateBatch(
  model: string,
  batch: string[],
  langLabel: string,
  wantRoman: boolean,
): Promise<TranslatedLine[]> {
  const numbered = batch.map((l, i) => `${i + 1}. ${l}`).join('\n')
  const romanRule = wantRoman
    ? 'For "r": if the ORIGINAL line uses a non-Latin script (Japanese, Korean, Chinese, Cyrillic, Arabic, etc.), write how to pronounce that original line using plain Latin letters (romaji/pinyin/romanized style). If the original line is already in Latin letters, use an empty string.'
    : 'For "r": always use an empty string.'
  const system = 'You translate song lyrics. You always answer with valid JSON only, no prose.'
  const user = [
    `Translate each numbered song lyric line into ${langLabel}.`,
    `Return JSON: { "lines": [ { "t": "...", "r": "..." }, ... ] } with EXACTLY ${batch.length} entries, one per numbered line, in the same order.`,
    `For "t": a natural ${langLabel} translation of the line. Keep it short and singable; do not add commentary.`,
    romanRule,
    '',
    'Lyric lines:',
    numbered,
  ].join('\n')

  const attempt = async (): Promise<TranslatedLine[]> => {
    const res = await ollamaChat(
      model,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      undefined,
      { temperature: 0.2, num_predict: 2600 },
      FORMAT_SCHEMA,
    )
    const parsed = JSON.parse(res.message.content ?? '{}') as { lines?: Array<{ t?: unknown; r?: unknown }> }
    if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) throw new Error('No lines in translation output')
    return parsed.lines.slice(0, batch.length).map((l) => ({
      t: typeof l?.t === 'string' ? l.t.trim() : '',
      r: typeof l?.r === 'string' && l.r.trim() ? l.r.trim() : null,
    }))
  }

  let out: TranslatedLine[]
  try {
    out = await attempt()
  } catch {
    out = await attempt() // one retry; local models occasionally emit short/invalid batches
  }
  // Pad a short batch rather than misaligning every following line.
  while (out.length < batch.length) out.push({ t: '', r: null })
  return out
}

// Concurrent requests for the same (track, lang) share one generation instead of racing
// two full LLM passes (two family members opening the same song is the common case).
const inFlight = new Map<string, Promise<TranslatedLine[]>>()

export async function translateLyrics(input: {
  artist: string
  title: string
  lang: string
  lines: string[]
}): Promise<TranslatedLine[]> {
  const langLabel = LYRIC_LANGS[input.lang]
  if (!langLabel) throw new Error('Unsupported language')

  const lines = input.lines.slice(0, MAX_LINES).map((l) => String(l ?? '').slice(0, MAX_LINE_CHARS))
  const trackKey = normalizeTrackKey(input.artist, input.title)
  const hash = sourceHashOf(lines)

  const cached = await db.select().from(lyricTranslations)
    .where(and(eq(lyricTranslations.trackKey, trackKey), eq(lyricTranslations.lang, input.lang)))
    .limit(1)
  if (cached[0] && cached[0].sourceHash === hash) {
    try {
      const parsed = JSON.parse(cached[0].lines) as TranslatedLine[]
      if (Array.isArray(parsed)) return parsed
    } catch { /* corrupt cache row; regenerate below */ }
  }

  const flightKey = `${trackKey}|${input.lang}|${hash}`
  const existing = inFlight.get(flightKey)
  if (existing) return existing

  const job = (async () => {
    const model = await getFastModel()
    const wantRoman = lines.some(hasNonLatinScript)

    // Only non-empty lines go to the model; blanks stay blank at their original index.
    const work: Array<{ idx: number; text: string }> = []
    lines.forEach((text, idx) => { if (text.trim()) work.push({ idx, text }) })

    const result: TranslatedLine[] = lines.map(() => ({ t: '', r: null }))
    for (let i = 0; i < work.length; i += BATCH_SIZE) {
      const chunk = work.slice(i, i + BATCH_SIZE)
      const translated = await translateBatch(model, chunk.map((w) => w.text), langLabel, wantRoman)
      chunk.forEach((w, j) => { result[w.idx] = translated[j] ?? { t: '', r: null } })
    }

    const now = new Date()
    await db.insert(lyricTranslations)
      .values({ id: crypto.randomUUID(), trackKey, lang: input.lang, sourceHash: hash, lines: JSON.stringify(result), createdAt: now })
      .onConflictDoUpdate({
        target: [lyricTranslations.trackKey, lyricTranslations.lang],
        set: { sourceHash: hash, lines: JSON.stringify(result), createdAt: now },
      })
    return result
  })()

  inFlight.set(flightKey, job)
  try {
    return await job
  } finally {
    inFlight.delete(flightKey)
  }
}
