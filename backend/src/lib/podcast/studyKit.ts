// Homework mode: turn a generated episode's script (its transcript) into a study kit --
// a short bullet summary, 5-10 Q&A flashcards, and timestamped key points -- saved as a
// note in the notes app. Uses only the transcript the episode already has (scriptJson);
// no new transcription infrastructure.

import { structuredCall } from '@/llm/structured'
import { getFastModel } from '@/lib/models'
import type { ScriptTurn } from './types'

export interface StudyKit {
  summary: string[]
  flashcards: Array<{ q: string; a: string }>
  keyPoints: Array<{ time: string; point: string }>
}

const SPOKEN_WPM = 165 // matches the script generator's pacing assumption
const TRANSCRIPT_CHAR_BUDGET = 9_000

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Attach an estimated start time to each turn. Word-count pacing (165 wpm) gives the raw
 * offsets; when the episode's real duration is known the offsets are scaled to it, so the
 * timestamps line up with the actual audio well enough to seek by.
 */
export function timestampTurns(
  turns: Array<{ speaker: string; text: string }>,
  durationSec: number | null,
): Array<{ atSec: number; speaker: string; text: string }> {
  const wordCounts = turns.map((t) => t.text.split(/\s+/).filter(Boolean).length)
  const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1
  const estimatedTotal = (totalWords / SPOKEN_WPM) * 60
  const scale = durationSec && estimatedTotal > 0 ? durationSec / estimatedTotal : 1
  let cursorWords = 0
  return turns.map((t, i) => {
    const atSec = ((cursorWords / SPOKEN_WPM) * 60) * scale
    cursorWords += wordCounts[i] ?? 0
    return { atSec, speaker: t.speaker, text: t.text }
  })
}

export async function generateStudyKit(input: {
  episodeTitle: string
  showName: string
  transcript: Array<{ speaker: string; text: string }>
  durationSec: number | null
}): Promise<StudyKit> {
  const timed = timestampTurns(input.transcript, input.durationSec)

  // Bounded transcript: keep whole turns until the budget runs out.
  const lines: string[] = []
  let used = 0
  for (const t of timed) {
    const line = `[${fmtTime(t.atSec)}] ${t.speaker}: ${t.text}`
    if (used + line.length > TRANSCRIPT_CHAR_BUDGET) break
    lines.push(line)
    used += line.length
  }

  const model = await getFastModel()
  const out = await structuredCall<{
    summary?: unknown
    flashcards?: Array<{ q?: unknown; a?: unknown }>
    keyPoints?: Array<{ time?: unknown; point?: unknown }>
  }>(
    model,
    [
      `Podcast episode: "${input.episodeTitle}" from the show "${input.showName}".`,
      'Transcript (each line starts with its [m:ss] timestamp):',
      lines.join('\n'),
      '',
      'Make a study kit for a school-age kid from this episode. Return JSON:',
      '{ "summary": [3-5 short bullet strings covering the big ideas],',
      '  "flashcards": [5-10 entries of { "q": a clear question, "a": a short answer }],',
      '  "keyPoints": [4-8 entries of { "time": the "m:ss" timestamp from the transcript line the point comes from, "point": one key fact or moment }] }',
      'Keep the language friendly, simple, and encouraging. Questions should test understanding, not trivia about the hosts. Use only facts from the transcript.',
    ].join('\n'),
    'You are a friendly study helper who turns podcast transcripts into study materials for kids.',
    { num_predict: 1800 },
  )

  const summary = Array.isArray(out.summary)
    ? out.summary.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 6)
    : []
  const flashcards = Array.isArray(out.flashcards)
    ? out.flashcards
        .map((f) => ({ q: String(f?.q ?? '').trim(), a: String(f?.a ?? '').trim() }))
        .filter((f) => f.q && f.a)
        .slice(0, 10)
    : []
  const keyPoints = Array.isArray(out.keyPoints)
    ? out.keyPoints
        .map((k) => ({ time: String(k?.time ?? '').trim(), point: String(k?.point ?? '').trim() }))
        .filter((k) => k.point)
        .slice(0, 8)
    : []

  if (flashcards.length < 3 || summary.length === 0) throw new Error('Study kit generation came back incomplete')
  return { summary, flashcards, keyPoints }
}

/** Render the kit as the markdown note body. */
export function studyKitMarkdown(kit: StudyKit, episodeTitle: string, showName: string): string {
  const parts: string[] = []
  parts.push(`Study notes for the episode "${episodeTitle}" from ${showName}.`)
  parts.push('', '## Quick summary', ...kit.summary.map((s) => `- ${s}`))
  parts.push('', '## Flashcards')
  kit.flashcards.forEach((f, i) => {
    parts.push(`${i + 1}. **Q:** ${f.q}`, `   **A:** ${f.a}`)
  })
  if (kit.keyPoints.length) {
    parts.push('', '## Key moments', ...kit.keyPoints.map((k) => k.time ? `- **${k.time}** ${k.point}` : `- ${k.point}`))
  }
  return parts.join('\n')
}
