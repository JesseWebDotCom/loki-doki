// Shared yt-dlp metadata runner for hub providers (TikTok, Vimeo fallback). Mirrors
// lib/clipper/resolve.ts's -J pattern, with extra-args support for flat playlist
// extraction and the global yt-dlp concurrency slot.

import { spawn } from 'node:child_process'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'

export async function ytDlpJson<T = Record<string, unknown>>(url: string, extraArgs: string[] = []): Promise<T> {
  const raw = await withYtDlpSlot(() => new Promise<string>((resolve, reject) => {
    const proc = spawn(ytDlpBin(), ['-J', '--no-warnings', ...extraArgs, url], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let errTail = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2048) })
    proc.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(errTail.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || `yt-dlp exited ${code}`))
    })
    proc.on('error', reject)
  }))
  return JSON.parse(raw) as T
}
