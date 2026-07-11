// Synthesize speech with natural pauses spliced in — a longer breath between sentences and a
// shorter beat at em/en dashes. Kokoro reads a whole paragraph in one breathless rush; chunking
// the text and butting silence between the clips is what gives the AI DJ (and any other caller)
// real phrasing. Returns a single mono int16 WAV, or null if synthesis failed.

import { voiceServerLocalUrl } from '@/lib/voiceServer'
import { segmentSentences } from '@/lib/voice/sentenceSegmenter'
import { wavToInt16, pcmToWav } from '@/lib/voice/pcm'

const SENTENCE_GAP_SEC = 0.34   // breath between sentences (default / long-form narration)
const DASH_GAP_SEC = 0.20       // shorter beat at an em/en dash

interface SpeechChunk { text: string; gapSec: number }

// Split into speakable chunks, recording the pause to insert AFTER each. Sentences come from the
// shared segmenter (so abbreviations / decimals don't trigger false breaks); each sentence is then
// optionally split on em/en dashes — and hyphens used as dashes (spaced or doubled), which leaves
// intra-word hyphens like "hip-hop" / "T-Pain" intact. The final chunk gets no trailing gap.
function planChunks(text: string, sentenceGapSec: number, splitDashes: boolean): SpeechChunk[] {
  const chunks: SpeechChunk[] = []
  const sentences = segmentSentences(text)
  sentences.forEach((sentence, si) => {
    const isLastSentence = si === sentences.length - 1
    const parts = splitDashes
      ? sentence.split(/\s*[—–]\s*|\s+-{1,2}\s+/).map((p) => p.trim()).filter(Boolean)
      : [sentence]
    parts.forEach((part, pi) => {
      const isLastPart = pi === parts.length - 1
      const gapSec = isLastPart ? (isLastSentence ? 0 : sentenceGapSec) : DASH_GAP_SEC
      chunks.push({ text: part, gapSec })
    })
  })
  return chunks
}

export async function synthesizeWithPauses(
  text: string,
  opts: { voice: string; speed?: number; signal?: AbortSignal; sentenceGapSec?: number; splitDashes?: boolean },
): Promise<Buffer | null> {
  const sentenceGapSec = opts.sentenceGapSec ?? SENTENCE_GAP_SEC
  const splitDashes = opts.splitDashes ?? true
  const chunks = planChunks(text, sentenceGapSec, splitDashes)
  if (!chunks.length) return null

  const base = voiceServerLocalUrl()
  let sampleRate = 24000

  // Synthesize every chunk concurrently — each is an independent Kokoro call — so a multi-sentence
  // DJ line costs one round-trip instead of N sequential ones. Results are assembled in order
  // afterwards, with the inter-chunk silences preserved.
  const rendered = await Promise.all(chunks.map(async (chunk) => {
    const res = await fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk.text, voice: opts.voice, speed: opts.speed ?? 1.0 }),
      // Bound a wedged sidecar so an AI-DJ render can't hang forever.
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const { samples, sampleRate: sr } = wavToInt16(await res.arrayBuffer())
    return { samples, sampleRate: sr, gapSec: chunk.gapSec }
  }))
  if (rendered.some(r => r === null)) return null

  const segments: Int16Array[] = []
  for (const r of rendered) {
    sampleRate = r!.sampleRate
    segments.push(r!.samples)
    if (r!.gapSec > 0) segments.push(new Int16Array(Math.floor(sampleRate * r!.gapSec)))
  }

  const total = segments.reduce((n, s) => n + s.length, 0)
  if (!total) return null
  const merged = new Int16Array(total)
  let off = 0
  for (const s of segments) { merged.set(s, off); off += s.length }
  return pcmToWav(merged, sampleRate)
}
