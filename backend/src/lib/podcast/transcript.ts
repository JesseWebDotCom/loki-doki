// Source-agnostic transcript resolution for the podcast pipeline. YouTube keeps its existing
// caption path (cookie-aware, language auto-detect); every other yt-dlp-supported source
// (TikTok/Vimeo/Reddit/link) pulls its subtitle track straight from the page URL with the
// same `--write-subs --skip-download` mechanism — no media download. Returns null when a
// video has no captions, so "make a podcast" degrades to a title-only mention rather than
// failing. The script/TTS half of the pipeline is already source-agnostic once it has text.

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'
import { userPath } from '@/lib/storage/paths'
import { cleanVttText, getTranscriptText } from '@/lib/youtube/transcript'

/** A video to transcribe. `source` defaults to youtube; non-YouTube sources must carry the
 *  canonical page `url` (yt-dlp needs a real URL — a bare id isn't enough for TikTok etc.). */
export interface TranscriptRef {
  videoId: string
  source?: string | null
  url?: string | null
}

export async function resolveVideoTranscript(ref: TranscriptRef, userId: string, userFirstName: string): Promise<string | null> {
  const source = ref.source ?? 'youtube'
  if (source === 'youtube') return getTranscriptText(ref.videoId, userId, userFirstName)
  if (!ref.url) return null
  return fetchSubsTranscript(source, ref.videoId, ref.url, userId, userFirstName)
}

async function fetchSubsTranscript(source: string, id: string, url: string, userId: string, userFirstName: string): Promise<string | null> {
  const outDir = await userPath(userId, userFirstName, 'videos/transcripts' as never, source)
  await mkdir(outDir, { recursive: true })
  const base = id.replace(/[^\w.-]/g, '_')
  const findVtt = async () => (await readdir(outDir).catch(() => [] as string[])).find((f) => f.startsWith(`${base}.`) && f.endsWith('.vtt'))

  // Reuse an already-fetched transcript before spending a yt-dlp call.
  let file = await findVtt()
  if (!file) {
    try {
      await withYtDlpSlot(() => new Promise<void>((resolve, reject) => {
        const proc = spawn(ytDlpBin(), [
          '--write-auto-subs', '--write-subs',
          '--sub-langs', 'en.*,eng.*',
          '--sub-format', 'vtt',
          '--skip-download',
          '--output', join(outDir, `${base}.%(ext)s`),
          '--no-playlist', '--quiet',
          url,
        ], { stdio: 'ignore', windowsHide: true })
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`code ${code}`)))
        proc.on('error', reject)
      }), { background: true })
    } catch { /* captions are optional */ }
    file = await findVtt()
  }
  if (!file) return null
  const text = cleanVttText(await readFile(join(outDir, file), 'utf-8'))
  return text.length >= 80 ? text : null
}
