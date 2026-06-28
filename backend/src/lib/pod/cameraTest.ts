// Swappable TEST source for the Pod camera UDP streamer, so we can measure the
// device's real frame-rate ceiling independent of Frigate:
//   • ffmpeg  — a generated moving test pattern at any fps / size / quality (the most
//               useful: controlled, always available, lets us isolate UDP fragment loss
//               by shrinking frames).
//   • urls    — rotate through public MJPEG stream URLs, using the first that delivers
//               frames (falls over to the next if one stalls or goes offline).
// When a test source is active, cameraUdp streams ITS latest frame instead of Frigate's.

import { spawn, type ChildProcess } from 'node:child_process'
import { logger } from '@/lib/logger'

const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])

let active = false
let manualMode = false // true = a manual test (pattern/urls) the user chose; false = the default feed
let latest: Buffer | null = null
let ff: ChildProcess | null = null
let httpAbort: AbortController | null = null

export function isTestActive(): boolean { return active }
export function isManualSource(): boolean { return manualMode }
export function latestTestFrame(): Buffer | null { return latest }

export function stopTest(): void {
  active = false
  latest = null
  if (ff) { try { ff.kill('SIGKILL') } catch { /* ignore */ } ff = null }
  if (httpAbort) { try { httpAbort.abort() } catch { /* ignore */ } httpAbort = null }
}

// Pull every complete JPEG out of an accumulating buffer, keeping the freshest as latest.
function drain(buf: Buffer): Buffer {
  let s = buf.indexOf(SOI)
  while (s >= 0) {
    const e = buf.indexOf(EOI, s + 2)
    if (e < 0) break
    latest = buf.subarray(s, e + 2)
    buf = buf.subarray(e + 2)
    s = buf.indexOf(SOI)
  }
  return buf.length > 4_000_000 ? Buffer.alloc(0) : buf
}

/** Generated moving test pattern via ffmpeg → MJPEG on stdout. */
export function startFfmpegTest(fps = 30, w = 640, h = 360, q = 6): void {
  stopTest()
  active = true
  manualMode = true
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-re', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`,
    '-c:v', 'mjpeg', '-q:v', String(q), '-f', 'mjpeg', 'pipe:1',
  ]
  const proc = spawn('ffmpeg', args)
  ff = proc
  let buf: Buffer = Buffer.alloc(0)
  proc.stdout.on('data', (chunk: Buffer) => { if (active) buf = drain(buf.length ? Buffer.concat([buf, chunk]) : chunk) as Buffer })
  proc.stderr.on('data', (d: Buffer) => logger.warn(`[pod-camera] ffmpeg: ${d.toString().trim().slice(0, 200)}`))
  proc.on('exit', (code) => { if (ff === proc) { ff = null; active = false; logger.warn(`[pod-camera] ffmpeg test exited (${code})`) } })
  logger.info(`[pod-camera] TEST source = ffmpeg ${w}x${h}@${fps}fps q${q}`)
}

/** Transcode an existing stream (e.g. the Frigate camera MJPEG) to a target size via
 *  ffmpeg, so the device decodes a native panel-size frame and skips the CPU upscale. */
export function startFfmpegSource(inputUrl: string, w = 1280, h = 720, fps = 25, q = 12): void {
  stopTest()
  active = true
  manualMode = false // this is the default device feed, not a manual override
  const args = [
    '-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-i', inputUrl,
    '-vf', `scale=${w}:${h}:flags=fast_bilinear`, '-r', String(fps),
    '-c:v', 'mjpeg', '-q:v', String(q), '-f', 'mjpeg', 'pipe:1',
  ]
  const proc = spawn('ffmpeg', args)
  ff = proc
  let buf: Buffer = Buffer.alloc(0)
  proc.stdout.on('data', (chunk: Buffer) => { if (active) buf = drain(buf.length ? Buffer.concat([buf, chunk]) : chunk) as Buffer })
  proc.stderr.on('data', (d: Buffer) => logger.warn(`[pod-camera] ffmpeg: ${d.toString().trim().slice(0, 200)}`))
  proc.on('exit', (code) => { if (ff === proc) { ff = null; active = false; logger.warn(`[pod-camera] ffmpeg source exited (${code})`) } })
  logger.info(`[pod-camera] source = ffmpeg(${inputUrl}) → ${w}x${h}@${fps}fps q${q}`)
}

/** Rotate through public MJPEG URLs, using the first that yields frames. */
export function startUrlTest(urls: string[]): void {
  stopTest()
  active = true
  manualMode = true
  let idx = 0
  void (async () => {
    while (active) {
      const url = urls[idx % urls.length]!
      const ac = new AbortController()
      httpAbort = ac
      try {
        logger.info(`[pod-camera] TEST source → ${url}`)
        const r = await fetch(url, { signal: ac.signal })
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
        let buf: Buffer = Buffer.alloc(0)
        let lastFrameAt = Date.now()
        const before = latest
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          if (!active) break
          buf = drain(buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk)) as Buffer
          if (latest !== before) lastFrameAt = Date.now()
          if (Date.now() - lastFrameAt > 5000) break // stalled → rotate
        }
      } catch (e) {
        logger.warn(`[pod-camera] test url failed (${url}): ${e}`)
      }
      idx++
      await new Promise((z) => setTimeout(z, 1000))
    }
  })()
}
