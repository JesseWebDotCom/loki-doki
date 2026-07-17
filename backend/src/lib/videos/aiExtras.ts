// AI extras over the transcript stack: auto-chapters, spoiler-aware catch-me-up recaps,
// and clippable-moment suggestions. Each is a thin recombination of pieces already here
// (transcripts, the semantic index's VTT chunker, the local model), which is exactly why
// they're cheap for us and Premium features for YouTube.

import { readFile } from 'node:fs/promises'
import { ollamaChat } from '@/llm/ollama'
import { getModel, getFastModel } from '@/lib/models'
import { ensureTranscript } from '@/lib/youtube/download'
import { resolveVideoVtt } from '@/lib/podcast/transcript'
import { parseVttCues, chunkCues } from '@/lib/videos/semanticIndex'
import { cachedLookup } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface AiChapter { start: number; title: string }
export interface ClipSuggestion { startSec: number; endSec: number; title: string; why: string }

/** Timed transcript text for a video, as "[t=<sec>] line" rows the model can cite. */
async function timedTranscript(
  source: string, videoId: string, userId: string, userFirstName: string, url: string | null,
): Promise<{ lines: string; durationSec: number } | null> {
  let vtt: string | null = null
  try {
    if (source === 'youtube') {
      const p = await ensureTranscript(videoId, userId, userFirstName)
      if (p) vtt = await readFile(p, 'utf-8').catch(() => null)
    } else {
      vtt = await resolveVideoVtt({ source, videoId, url: url ?? undefined }, userId, userFirstName)
    }
  } catch { /* caption fetch failed */ }
  if (!vtt) return null
  const cues = parseVttCues(vtt)
  if (cues.length === 0) return null
  const chunks = chunkCues(cues)
  if (chunks.length === 0) return null
  const durationSec = Math.ceil(cues[cues.length - 1]!.start)
  const lines = chunks.map((ch) => `[t=${Math.floor(ch.start)}] ${ch.text}`).join('\n').slice(0, 14_000)
  return { lines, durationSec }
}

/** Parse `[t=123] Title` rows out of a model reply, dropping anything malformed. */
function parseTimedList(text: string, durationSec: number): AiChapter[] {
  const out: AiChapter[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/\[t=(\d+)\]\s*(.+)$/)
    if (!m) continue
    const start = Number(m[1])
    const title = m[2]!.trim().replace(/^["'\-–\s]+|["']+$/g, '').slice(0, 80)
    if (!title || !Number.isFinite(start) || start < 0 || start > durationSec + 60) continue
    out.push({ start, title })
  }
  const sorted = out.sort((a, b) => a.start - b.start)
  return sorted.filter((c, i) => i === 0 || c.start - sorted[i - 1]!.start >= 20)
}

// ── Auto-chapters ────────────────────────────────────────────────────────────────
// Commodity now (Panopto, Kaltura and Mux all ship LLM-over-transcript chaptering), but
// only for videos whose creator never added any. Cached a week: the transcript doesn't
// change, so neither do the chapters.

export async function autoChapters(opts: {
  source: string; videoId: string; title: string | null; url: string | null
  userId: string; userFirstName: string
}): Promise<AiChapter[]> {
  const cached = await cachedLookup(`videos:autochapters`, `${opts.source}:${opts.videoId}`, 7 * 24 * 60 * 60_000, async () => {
    const t = await timedTranscript(opts.source, opts.videoId, opts.userId, opts.userFirstName, opts.url)
    if (!t) return []
    try {
      const model = await getFastModel()
      const res = await ollamaChat(
        model,
        [
          {
            role: 'system',
            content:
              'You split a video into chapters from its transcript. Each transcript line starts with its time as [t=<seconds>]. ' +
              'Reply with one chapter per line, formatted exactly "[t=<seconds>] Short title" and nothing else. ' +
              'Use between 3 and 10 chapters, spread across the whole video, each starting at a real topic change. ' +
              'Titles are 2-6 plain words describing that section. The first chapter starts at [t=0].',
          },
          { role: 'user', content: `${opts.title ? `Video: ${opts.title}\n\n` : ''}${t.lines}` },
        ],
        undefined,
        { temperature: 0.2, num_predict: 400 },
        undefined,
        45_000,
      )
      const chapters = parseTimedList(res.message.content ?? '', t.durationSec)
      // Fewer than 2 is not a chaptering; better to show none than a single bogus mark.
      return chapters.length >= 2 ? chapters : []
    } catch (err) {
      logger.debug(`[videos/ai] autoChapters failed: ${String(err)}`)
      return []
    }
  })
  return cached ?? []
}

// ── Catch me up ──────────────────────────────────────────────────────────────────
// Prime Video's X-Ray Recaps: a recap of everything UP TO where you stopped, and not one
// second past it. The spoiler safety is structural rather than a prompt plea: the model
// is only ever handed the transcript before the resume point.

export async function catchMeUp(opts: {
  source: string; videoId: string; title: string | null; url: string | null
  uptoSec: number
  userId: string; userFirstName: string
}): Promise<string | null> {
  const t = await timedTranscript(opts.source, opts.videoId, opts.userId, opts.userFirstName, opts.url)
  if (!t) return null
  // Structural spoiler guard: drop every chunk at or after the resume point.
  const before = t.lines.split('\n').filter((line) => {
    const m = line.match(/^\[t=(\d+)\]/)
    return m ? Number(m[1]) < opts.uptoSec : false
  })
  if (before.length === 0) return null
  try {
    const model = await getModel()
    const res = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content:
            'You remind someone what has happened so far in a video they paused partway through, using ONLY the transcript excerpts given. ' +
            'Three or four short sentences covering the story or argument up to this point. Present tense, plain language, no preamble. ' +
            'You have not been shown the rest, so never speculate about what happens next. Reply with ONLY the recap.',
        },
        { role: 'user', content: `${opts.title ? `Video: ${opts.title}\n\n` : ''}${before.join('\n').slice(0, 12_000)}` },
      ],
      undefined,
      { temperature: 0.3, num_predict: 300 },
      undefined,
      45_000,
    )
    const text = res.message.content?.trim()
    return text && text.length > 20 ? text : null
  } catch (err) {
    logger.debug(`[videos/ai] catchMeUp failed: ${String(err)}`)
    return null
  }
}

// ── Clip suggestions ─────────────────────────────────────────────────────────────
// YouTube's 2026 "Video Clips to Shorts" suggests clippable moments to creators; the same
// idea serves the Clipper and the Studio here.

export async function suggestClips(opts: {
  source: string; videoId: string; title: string | null; url: string | null
  userId: string; userFirstName: string
}): Promise<ClipSuggestion[]> {
  const cached = await cachedLookup(`videos:clipsuggest`, `${opts.source}:${opts.videoId}`, 7 * 24 * 60 * 60_000, async () => {
    const t = await timedTranscript(opts.source, opts.videoId, opts.userId, opts.userFirstName, opts.url)
    if (!t) return []
    try {
      const model = await getModel()
      const res = await ollamaChat(
        model,
        [
          {
            role: 'system',
            content:
              'You find the most clippable moments in a video from its transcript. Each line starts with its time as [t=<seconds>]. ' +
              'Reply with one moment per line, formatted exactly "[t=<start>] <end seconds> | Short title | why it works", and nothing else. ' +
              'Pick 3 to 5 moments, each 15-60 seconds, that stand alone without context: a punchline, a reveal, a strong claim, a satisfying result.',
          },
          { role: 'user', content: `${opts.title ? `Video: ${opts.title}\n\n` : ''}${t.lines}` },
        ],
        undefined,
        { temperature: 0.4, num_predict: 400 },
        undefined,
        45_000,
      )
      const out: ClipSuggestion[] = []
      for (const line of (res.message.content ?? '').split('\n')) {
        const m = line.match(/\[t=(\d+)\]\s*(\d+)\s*\|\s*([^|]+)\|\s*(.+)$/)
        if (!m) continue
        const startSec = Number(m[1])
        const endSec = Number(m[2])
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue
        // Trust the transcript's clock over the model's arithmetic on length.
        const bounded = Math.min(endSec, startSec + 90)
        out.push({
          startSec, endSec: bounded,
          title: m[3]!.trim().slice(0, 80),
          why: m[4]!.trim().slice(0, 140),
        })
      }
      return out.slice(0, 5)
    } catch (err) {
      logger.debug(`[videos/ai] suggestClips failed: ${String(err)}`)
      return []
    }
  })
  return cached ?? []
}
