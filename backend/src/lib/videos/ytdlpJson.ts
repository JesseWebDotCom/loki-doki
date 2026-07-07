// Shared yt-dlp metadata runner for hub providers (TikTok, Vimeo fallback). Mirrors
// lib/clipper/resolve.ts's -J pattern, with extra-args support for flat playlist
// extraction and the global yt-dlp concurrency slot.
//
// A hard timeout kills a hung extraction so it can't hold a global yt-dlp slot forever
// (TikTok's scrape-hostile pages occasionally make yt-dlp wedge) — a stuck process used to
// permanently starve the pool and freeze every other yt-dlp consumer. `background` yields
// slot priority to interactive resolves (see withYtDlpSlot): the videos poller's cache
// warm passes it so a warm burst can never outrank a member clicking play.

import { spawn } from 'node:child_process'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'

// Flat-playlist metadata extraction is normally a few seconds; this only fires on a truly
// hung process. Generous enough to survive a cold PyInstaller start, low enough that a
// wedged extraction releases its slot promptly.
const TIMEOUT_MS = 20_000

export async function ytDlpJson<T = Record<string, unknown>>(
  url: string,
  extraArgs: string[] = [],
  opts?: { background?: boolean },
): Promise<T> {
  const raw = await withYtDlpSlot(() => new Promise<string>((resolve, reject) => {
    const proc = spawn(ytDlpBin(), ['-J', '--no-warnings', ...extraArgs, url], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let errTail = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, TIMEOUT_MS)
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2048) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`yt-dlp timed out after ${TIMEOUT_MS}ms`))
      else if (code === 0) resolve(out)
      else reject(new Error(errTail.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || `yt-dlp exited ${code}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  }), { background: opts?.background })
  return JSON.parse(raw) as T
}
