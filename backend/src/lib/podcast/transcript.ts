// Source-agnostic transcript resolution for the podcast pipeline. YouTube keeps its existing
// caption path (cookie-aware, language auto-detect); every other yt-dlp-supported source
// (TikTok/Vimeo/Reddit/link) pulls its subtitle track straight from the page URL with the
// same `--write-subs --skip-download` mechanism — no media download. Returns null when a
// video has no captions, so "make a podcast" degrades to a title-only mention rather than
// failing. The script/TTS half of the pipeline is already source-agnostic once it has text.

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'
import { userPath } from '@/lib/storage/paths'
import { cleanVttText, getTranscriptText } from '@/lib/youtube/transcript'
import { getProvider } from '@/lib/videos/registry'

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
  const vtt = await resolveVideoVtt(ref, userId, userFirstName)
  if (!vtt) return null
  const text = cleanVttText(vtt)
  return text.length >= 80 ? text : null
}

/** Raw WebVTT (with cue timings) for a non-YouTube video — for the timed transcript panel.
 *  Same yt-dlp subtitle fetch as the plain-text path, cached on disk per user/source. */
export async function resolveVideoVtt(ref: TranscriptRef, userId: string, userFirstName: string): Promise<string | null> {
  if ((ref.source ?? 'youtube') === 'youtube' || !ref.url) return null
  const source = ref.source!
  const outDir = await userPath(userId, userFirstName, 'videos/transcripts' as never, source)
  await mkdir(outDir, { recursive: true })
  const base = ref.videoId.replace(/[^\w.-]/g, '_')
  const findVtt = async () => (await readdir(outDir).catch(() => [] as string[])).find((f) => f.startsWith(`${base}.`) && f.endsWith('.vtt'))

  // Reuse an already-fetched transcript before spending a yt-dlp call.
  let file = await findVtt()
  if (!file) {
    // Platform-API fast path (provider.getCaptions, e.g. Vimeo texttracks): one small
    // fetch instead of a whole yt-dlp subtitle run. Cached to the same per-user dir so
    // subsequent reads never refetch.
    const apiVtt = await getProvider(source)?.getCaptions?.(ref.videoId).catch(() => null)
    if (apiVtt) {
      await writeFile(join(outDir, `${base}.api.vtt`), apiVtt, 'utf-8').catch(() => {})
      return apiVtt
    }
  }
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
          ref.url!,
        ], { stdio: 'ignore', windowsHide: true })
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`code ${code}`)))
        proc.on('error', reject)
      }), { background: true })
    } catch { /* captions are optional */ }
    file = await findVtt()
  }
  if (!file) return null
  return readFile(join(outDir, file), 'utf-8')
}
