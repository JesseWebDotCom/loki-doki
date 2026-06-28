// Live camera frame source for screen Pods (Tab5 perf test).
//
// Maintains ONE persistent MJPEG reader per Frigate camera and caches the latest
// complete JPEG frame. A device GET then returns that cached frame INSTANTLY, so the
// device's frame rate is bounded only by its own Wi-Fi + hardware-JPEG decode — not
// by a fresh upstream fetch per request. That's exactly the throughput we want to
// measure with the on-screen FPS counter.
//
// The reader auto-stops if no device has polled it for a while, so we don't hold a
// stream open against Frigate forever.

import { getFrigateConfig } from '@/lib/frigate/config'
import { logger } from '@/lib/logger'

const SOI = Buffer.from([0xff, 0xd8]) // JPEG start-of-image
const EOI = Buffer.from([0xff, 0xd9]) // JPEG end-of-image

// Upstream pull settings. Height drives the frame size (width follows the camera's
// aspect — a 16:9 cam at h=720 yields ~1280×720, which matches the device buffer).
const CAM_FPS = parseInt(process.env.POD_CAM_FPS ?? '20')
const CAM_HEIGHT = parseInt(process.env.POD_CAM_HEIGHT ?? '720')
const IDLE_STOP_MS = 30_000
const MAX_ACCUM = 4_000_000

interface CamReader {
  latest: Buffer | null
  lastFrameAt: number
  lastReadAt: number
  running: boolean
  ac: AbortController
}

const readers = new Map<string, CamReader>() // cameraName → reader
let livingRoom: { name: string; at: number } | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Find the "living room" camera by name from Frigate's config (cached 5 min). */
async function discoverLivingRoom(baseUrl: string): Promise<string | null> {
  if (livingRoom && Date.now() - livingRoom.at < 300_000) return livingRoom.name
  try {
    const r = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const cfg = (await r.json()) as { cameras?: Record<string, unknown> }
    const names = Object.keys(cfg.cameras ?? {})
    const name = names.find((n) => /living/i.test(n)) ?? names[0] ?? null
    if (name) {
      livingRoom = { name, at: Date.now() }
      logger.info(`[pod-camera] living-room camera → "${name}" (of ${names.length})`)
    }
    return name
  } catch (e) {
    logger.warn(`[pod-camera] could not read Frigate config: ${e}`)
    return null
  }
}

/** Spawn the background MJPEG pump for a camera. */
function startReader(baseUrl: string, name: string): CamReader {
  const reader: CamReader = {
    latest: null,
    lastFrameAt: 0,
    lastReadAt: Date.now(),
    running: true,
    ac: new AbortController(),
  }
  void (async () => {
    while (reader.running) {
      try {
        const url = `${baseUrl}/api/${encodeURIComponent(name)}?fps=${CAM_FPS}&h=${CAM_HEIGHT}`
        const r = await fetch(url, { signal: reader.ac.signal })
        if (!r.ok || !r.body) {
          await sleep(1000)
          continue
        }
        let buf = Buffer.alloc(0)
        // Bun exposes the web ReadableStream as async-iterable.
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          if (!reader.running) break
          buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk)
          // Pull out every complete JPEG; keep only the freshest (drop stale frames).
          let start = buf.indexOf(SOI)
          while (start >= 0) {
            const end = buf.indexOf(EOI, start + 2)
            if (end < 0) break
            reader.latest = buf.subarray(start, end + 2)
            reader.lastFrameAt = Date.now()
            buf = buf.subarray(end + 2)
            start = buf.indexOf(SOI)
          }
          if (buf.length > MAX_ACCUM) buf = Buffer.alloc(0) // runaway guard
          if (Date.now() - reader.lastReadAt > IDLE_STOP_MS) {
            reader.running = false
            break
          }
        }
      } catch {
        if (reader.running) await sleep(1000)
      }
    }
    readers.delete(name)
    logger.info(`[pod-camera] stopped reader for "${name}"`)
  })()
  return reader
}

/** The living-room camera's MJPEG URL (for an ffmpeg scaler to consume), or null. */
export async function livingRoomMjpegUrl(): Promise<string | null> {
  const cfg = await getFrigateConfig()
  if (!cfg.baseUrl) return null
  const name = await discoverLivingRoom(cfg.baseUrl)
  if (!name) return null
  return `${cfg.baseUrl}/api/${encodeURIComponent(name)}?fps=${CAM_FPS}&h=${CAM_HEIGHT}`
}

/** Latest cached frame from any running reader, WITHOUT a DB/config lookup — for the
 *  hot UDP send loop. Returns null until latestLivingRoomFrame() has started a reader. */
export function peekLivingRoomFrame(): Buffer | null {
  for (const rd of readers.values()) {
    if (rd.running && rd.latest) return rd.latest
  }
  return null
}

/** Latest JPEG frame of the living-room camera, or null if unavailable. */
export async function latestLivingRoomFrame(): Promise<Buffer | null> {
  const cfg = await getFrigateConfig()
  if (!cfg.baseUrl) return null
  const name = await discoverLivingRoom(cfg.baseUrl)
  if (!name) return null

  let rd = readers.get(name)
  if (!rd || !rd.running) {
    rd = startReader(cfg.baseUrl, name)
    readers.set(name, rd)
  }
  rd.lastReadAt = Date.now()
  // Cold reader: give it a moment to buffer the first frame so the caller (and the
  // device's first poll) doesn't get a spurious 503 before the stream has spun up.
  for (let i = 0; rd.latest == null && i < 30; i++) await sleep(100) // up to ~3s
  return rd.latest
}
