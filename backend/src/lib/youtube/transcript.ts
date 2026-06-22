// Transcript helpers shared by the summarize route and the podcast adapter.

import { readFile } from 'node:fs/promises'
import { ensureTranscript } from './download'

/**
 * Turn a WebVTT subtitle file into clean prose.
 *
 * YouTube auto-captions use "rolling" cues: each line is repeated across several
 * cues and carries inline word-level timing tags (e.g. `Good<00:00:00.560><c> morning.</c>`).
 * We strip every `<...>` tag, drop metadata/timing lines, then collapse adjacent
 * duplicate lines so the rolling repeats become a single readable stream.
 */
// Decode the HTML entities auto-captions arrive escaped as (&gt;&gt; speaker markers,
// &#39; apostrophes, &amp;, …) so the transcript and AI summary read as plain text.
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

export function cleanVttText(vtt: string): string {
  return decodeEntities(vtt.replace(/<[^>]+>/g, '')) // <c>/timestamp tags, then entities
    .replace(/(^|\s)>+(?=\s|$)/g, ' ')               // ">>" speaker-change markers → drop
    .split('\n')
    .map(l => l.trim())
    .filter(l =>
      l &&
      l !== 'WEBVTT' &&
      !l.startsWith('Kind:') &&
      !l.startsWith('Language:') &&
      !l.startsWith('NOTE') &&
      !l.includes('-->') &&                // cue timing lines
      !/^\d{2}:\d{2}/.test(l),             // any stray leading-timestamp lines
    )
    .filter((l, i, arr) => l !== arr[i - 1]) // collapse rolling-caption repeats
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Break the cleaned (often un-punctuated) caption stream into readable lines and
 * paragraphs for display. Auto-captions frequently have NO punctuation, so we wrap
 * on a word budget and prefer to break after sentence-ending words when present.
 */
export function formatTranscript(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return text
  const lines: string[] = []
  let line: string[] = []
  for (const w of words) {
    line.push(w)
    const endsSentence = /[.!?]["')\]]?$/.test(w)
    if (line.length >= 12 || (endsSentence && line.length >= 6)) {
      lines.push(line.join(' '))
      line = []
    }
  }
  if (line.length) lines.push(line.join(' '))
  const paras: string[] = []
  for (let i = 0; i < lines.length; i += 5) paras.push(lines.slice(i, i + 5).join('\n'))
  return paras.join('\n\n')
}

/**
 * Fetch (caption-only, no media download) and clean a video's transcript.
 * Returns clean prose, or null if the video has no usable captions.
 */
export async function getTranscriptText(
  videoId: string,
  userId: string,
  userFirstName: string,
): Promise<string | null> {
  const absPath = await ensureTranscript(videoId, userId, userFirstName)
  if (!absPath) return null
  try {
    const text = cleanVttText(await readFile(absPath, 'utf-8'))
    return text.length >= 80 ? text : null
  } catch {
    return null
  }
}
