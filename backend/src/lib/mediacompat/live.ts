// Live transcode pipe — plays an incompatible file NOW, while the cached rendition is
// still encoding (or before anyone asked for one). ffmpeg writes fragmented MP4 straight
// to the response, so playback starts in seconds; the trade-off is no byte-range seeking
// (the client seeks by re-requesting with ?t=). Desktop-oriented: iOS Safari can't play
// a non-seekable progressive stream, which is exactly why the cached path exists.

import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import type { Context } from 'hono'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { registerBusySignal } from '@/lib/idleScheduler'
import { logger } from '@/lib/logger'
import { type CompatProbe, probeCompat } from './probe'
import { buildConvertArgs, } from './transcode'
import { getTranscodeCrf, type CompatRow } from './store'

// A live pipe is a full decode+encode pinned to the request lifetime. Two concurrent
// pipes is plenty for a household and keeps worst-case CPU bounded alongside the (one)
// background transcode job.
const MAX_LIVE_PIPES = 2
let livePipes = 0

// A live pipe means someone is watching an incompatible file RIGHT NOW: hold the
// opportunistic background band closed so a precompute encode never contends with it.
registerBusySignal('live-transcode', () => (livePipes > 0 ? `${livePipes} live pipe(s) streaming` : null))

export async function streamLiveTranscode(c: Context, row: CompatRow): Promise<Response> {
  if (livePipes >= MAX_LIVE_PIPES) {
    return c.json({ error: 'Too many live transcodes — try again shortly' }, 503)
  }

  const bin = await ensureFfmpeg()
  let probe: CompatProbe | null = null
  try { probe = row.probeJson ? (JSON.parse(row.probeJson) as CompatProbe) : null } catch { /* re-probe */ }
  if (!probe) probe = await probeCompat(row.srcPath)

  const startSec = Math.max(0, Number(c.req.query('t') ?? 0) || 0)
  const isAudio = row.variant === 'audio' || !probe.hasVideo
  const crf = await getTranscodeCrf()
  const args = [
    '-nostdin', '-v', 'error',
    // Fast seek (before -i): jumps by keyframe, which is what a scrub wants.
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    '-i', row.srcPath,
    ...buildConvertArgs(probe, row.variant as 'video' | 'audio', crf),
    // Streamable MP4: moov up front, fragments as they encode.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', isAudio ? 'ipod' : 'mp4',
    'pipe:1',
  ]

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  livePipes++
  let done = false
  const finish = () => { if (!done) { done = true; livePipes-- } }
  let err = ''
  proc.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1024) })
  proc.on('close', (code) => {
    finish()
    if (code !== 0 && code !== null) logger.warn(`[media-compat] live pipe for ${row.id} exited ${code}: ${err.trim()}`)
  })
  proc.on('error', finish)
  // Client went away (pause, seek re-request, tab close) — stop burning CPU immediately.
  c.req.raw.signal.addEventListener('abort', () => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, { once: true })

  return new Response(Readable.toWeb(proc.stdout as Readable) as unknown as ReadableStream, {
    headers: {
      'Content-Type': isAudio ? 'audio/mp4' : 'video/mp4',
      'Cache-Control': 'no-store',
      // Deliberately no Accept-Ranges/Content-Length: this stream is not seekable.
    },
  })
}
