// Translated subtitles: watch anything in the family's language, on the family's server.
//
// Scope note: this is the SUBTITLE half of "auto-dubbing", deliberately. Spoken dubbing
// needs a TTS engine that can pronounce the target language, and the bundled one can't:
// kokoro-js ships non-English voice tensors but exposes only en-us/en-gb through its API,
// and its phonemizer is English-only (English G2P over Spanish text produces noise). A
// multilingual engine is a new dependency and an explicit architecture decision (see
// agents.md: XTTS/Piper/F5 deferred, Qwen3-TTS banned), so it belongs in a plan, not here.
// Translated captions need nothing new, and cover most of why a household wants dubbing.
//
// The translation is cue-by-cue in batches, keeping each cue's original timing, so it
// stays in sync with the picture without any alignment work.

import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { cachedLookup } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

/** Languages Whisper/our stack handle well enough to be worth offering. */
export const TRANSLATE_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'en', label: 'English' },
]

export function languageLabel(code: string): string | null {
  return TRANSLATE_LANGUAGES.find((l) => l.code === code)?.label ?? null
}

interface Block { header: string; text: string }

/** Split a VTT into cue blocks, keeping each cue's header (timing) verbatim. */
function parseBlocks(vtt: string): { preamble: string; blocks: Block[] } {
  const parts = vtt.split(/\r?\n\r?\n/)
  const blocks: Block[] = []
  let preamble = 'WEBVTT'
  for (const part of parts) {
    const lines = part.split(/\r?\n/)
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0) {
      if (part.trim().startsWith('WEBVTT')) preamble = part.trim()
      continue
    }
    const header = lines.slice(0, ti + 1).join('\n')
    const text = lines.slice(ti + 1).join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) blocks.push({ header, text })
  }
  return { preamble, blocks }
}

const BATCH = 40

/** Translate one batch of cue texts, returning exactly `lines.length` strings (or null). */
async function translateBatch(lines: string[], target: string): Promise<string[] | null> {
  const numbered = lines.map((t, i) => `${i + 1}. ${t}`).join('\n')
  try {
    const model = await getFastModel()
    const res = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content:
            `You translate subtitle lines into ${target}. Reply with the SAME number of lines, each "<n>. <translation>", and nothing else. ` +
            'Keep each line short enough to read as a subtitle. Translate meaning, not word for word. ' +
            'If a line is already in the target language, repeat it unchanged.',
        },
        { role: 'user', content: numbered },
      ],
      undefined,
      { temperature: 0.2, num_predict: 1400 },
      undefined,
      60_000,
    )
    const out: string[] = []
    for (const line of (res.message.content ?? '').split('\n')) {
      const m = line.match(/^\s*(\d+)\.\s*(.+)$/)
      if (!m) continue
      const idx = Number(m[1]) - 1
      if (idx >= 0 && idx < lines.length) out[idx] = m[2]!.trim()
    }
    // A model that dropped or merged lines would desync the whole file; fall back to the
    // original text for any gap rather than shifting every later cue.
    return lines.map((orig, i) => out[i] ?? orig)
  } catch (err) {
    logger.debug(`[videos/translate] batch failed: ${String(err)}`)
    return null
  }
}

/** Translate a whole VTT, preserving every cue's timing. Cached a week per (video, lang). */
export async function translateVtt(vtt: string, targetCode: string, cacheKey: string): Promise<string | null> {
  const target = languageLabel(targetCode)
  if (!target) return null
  const cached = await cachedLookup(`videos:vtt:${targetCode}`, cacheKey, 7 * 24 * 60 * 60_000, async () => {
    const { preamble, blocks } = parseBlocks(vtt)
    if (blocks.length === 0) return ''
    const translated: string[] = []
    for (let i = 0; i < blocks.length; i += BATCH) {
      const slice = blocks.slice(i, i + BATCH)
      const out = await translateBatch(slice.map((b) => b.text), target)
      if (!out) return ''   // model unavailable: don't cache a half-translated file
      translated.push(...out)
    }
    const body = blocks.map((b, i) => `${b.header}\n${translated[i] ?? b.text}`).join('\n\n')
    return `${preamble}\n\n${body}\n`
  })
  return cached ? cached : null
}
