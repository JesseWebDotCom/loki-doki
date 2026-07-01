// UDP push-stream of living-room camera frames to screen Pods (Tab5 perf path).
//
// WHY UDP: the ESP32-P4↔C6 esp-hosted SDIO bridge has an unfixed bug
// (espressif/esp-hosted-mcu#184) where sustained INBOUND TCP stalls once the C6's RX
// buffers fill and SDIO backpressure deadlocks — which capped our HTTP/TCP frame path
// at ~2 fps. UDP RX on the same hardware sustains ~36 Mbps (no flow control to
// deadlock), so we blast JPEG frames over UDP instead.
//
// Protocol (datagram): [frame_id u16 LE][frag_idx u8][frag_cnt u8][payload ≤1400B].
// The device reassembles by frame_id; a lost fragment just drops that one frame (video
// tolerates it) and the next frame_id starts fresh. The device announces itself by
// sending any datagram to our port (a 1 s "hello" keepalive); we stream to whoever has
// said hello within the last few seconds — NAT/firewall friendly, no device IP config.

import dgram from 'node:dgram'
import { isTestActive, isManualSource, latestTestFrame, startPublicCameraSource, stopTest } from '@/lib/pod/cameraTest'
import { anyDeviceInCameraMode, getDeviceMode } from '@/lib/pod/displayMode'
import { deviceByHwid, captureDeviceFrame } from '@/lib/pod/displayRenderer'
import { rendererForTemplateId, DEFAULT_TEMPLATE_ID } from '@/lib/pod/deviceStudio'
import { deviceView } from '@/lib/pod/displayController'
import { logger } from '@/lib/logger'

// Min gap between ambient layout frames per device (normal mode). The loop renders the
// next frame as soon as the previous send finishes, so this is a floor, not a fixed
// cadence — keeps it as smooth as the headless render allows without pegging the CPU.
const DISPLAY_MS = parseInt(process.env.POD_DISPLAY_UDP_MS ?? '120')

const PORT = parseInt(process.env.POD_CAM_UDP_PORT ?? '10701')
const FRAG = 1400 // payload bytes/datagram — under typical 1500 MTU to avoid IP fragmentation
const POLL_MS = parseInt(process.env.POD_CAM_UDP_POLL_MS ?? '8') // how often to check for a new source frame
// Fragment pacing: send BATCH datagrams, then pause PACE_MS, so a frame's fragments are
// spread out instead of bursting the C6 inbound buffer (the bursty-loss root cause).
// Mutable so they can be swept live (setPacing) without a restart.
let BATCH = parseInt(process.env.POD_CAM_UDP_BATCH ?? '3')
let PACE_MS = parseInt(process.env.POD_CAM_UDP_PACE_MS ?? '1')
const SUB_TTL_MS = 5000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Latest measured rates (updated every 2 s by the send loop), exposed for the speed test.
let statsSourceFps = 0
let statsSentFps = 0
let statsSubs = 0
export function cameraStats(): { sourceFps: number; sentFps: number; subs: number } {
  return { sourceFps: statsSourceFps, sentFps: statsSentFps, subs: statsSubs }
}

/** Tune fragment pacing at runtime (the send loop reads these every iteration). */
export function setPacing(batch?: number, paceMs?: number): { batch: number; paceMs: number } {
  if (typeof batch === 'number' && Number.isFinite(batch)) BATCH = Math.max(1, Math.floor(batch))
  if (typeof paceMs === 'number' && Number.isFinite(paceMs)) PACE_MS = Math.max(0, Math.floor(paceMs))
  return { batch: BATCH, paceMs: PACE_MS }
}

interface Sub { addr: string; port: number; last: number; mac?: string }

// Per-device stream health, parsed from the "LDC2" hello stats (keyed by device MAC).
interface DevStat {
  mac: string
  addr: string
  recvFps: number
  decFps: number
  lastBytes: number
  lastSeen: number
  _recv: number
  _dec: number
  _ts: number
}
const devStats = new Map<string, DevStat>()

const r1 = (n: number) => Math.round(n * 10) / 10

/** Per-device camera stream health: the full source→sent→received→decoded chain + loss%.
 *  loss% is the binding health signal (it varies with RF); absolute fps tracks the camera. */
export function deviceStreamHealth(): Array<{
  mac: string; addr: string; sourceFps: number; sentFps: number
  receivedFps: number; decodedFps: number; lossPct: number; lastBytes: number; ageMs: number
}> {
  const s = cameraStats()
  const now = Date.now()
  const out = []
  for (const d of devStats.values()) {
    if (now - d.lastSeen > 15000) continue // stale — device gone
    const lossPct = s.sentFps > 0 ? Math.max(0, Math.min(1, (s.sentFps - d.recvFps) / s.sentFps)) : 0
    out.push({
      mac: d.mac, addr: d.addr,
      sourceFps: r1(s.sourceFps), sentFps: r1(s.sentFps),
      receivedFps: r1(d.recvFps), decodedFps: r1(d.decFps),
      lossPct: Math.round(lossPct * 100), lastBytes: d.lastBytes, ageMs: now - d.lastSeen,
    })
  }
  return out
}

let started = false

export function startCameraUdp(): void {
  if (started) return
  started = true

  // reuseAddr so a dev hot-reload can re-bind the port without EADDRINUSE.
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const subs = new Map<string, Sub>()

  // Any datagram from a device = "I'm here, keep streaming to me". An "LDC2" hello also
  // carries the device's MAC + received/decoded/last_bytes counters → per-device health.
  sock.on('message', (msg, rinfo) => {
    const now = Date.now()
    const key = `${rinfo.address}:${rinfo.port}`
    const sub = subs.get(key) ?? { addr: rinfo.address, port: rinfo.port, last: now }
    sub.last = now
    subs.set(key, sub)
    if (msg.length >= 22 && msg[0] === 0x4c && msg[1] === 0x44 && msg[2] === 0x43 && msg[3] === 0x32) {
      const mac = msg.subarray(4, 10).toString('hex')
      sub.mac = mac // remember which device this addr is, so we can stream IT its layout
      const recv = msg.readUInt32LE(10)
      const dec = msg.readUInt32LE(14)
      const lastBytes = msg.readUInt32LE(18)
      const p = devStats.get(mac)
      let recvFps = p?.recvFps ?? 0
      let decFps = p?.decFps ?? 0
      if (p && now > p._ts && recv >= p._recv) {
        const dt = (now - p._ts) / 1000
        recvFps = (recv - p._recv) / dt
        decFps = (dec - p._dec) / dt
      }
      devStats.set(mac, { mac, addr: rinfo.address, recvFps, decFps, lastBytes, lastSeen: now, _recv: recv, _dec: dec, _ts: now })
    }
  })
  sock.on('error', (e) => logger.warn(`[pod-camera] UDP socket error: ${e}`))
  sock.bind(PORT, () => logger.info(`[pod-camera] UDP frame stream listening on :${PORT}`))

  // Source watchdog: run a camera source ONLY when a screen device is actually in
  // camera-test mode (Admin → Devices → Testing) — no camera mode ⇒ no ffmpeg, no
  // wasted bandwidth in normal/touch mode. The source is a PUBLIC test feed (with a
  // generated fallback) so it works with no Frigate. A MANUAL test (pattern/urls/own
  // camera) overrides and is left untouched until cleared.
  setInterval(() => {
    if (isManualSource()) return
    const wantCamera = subs.size > 0 && anyDeviceInCameraMode()
    if (wantCamera) {
      if (!isTestActive()) startPublicCameraSource()
    } else if (isTestActive()) {
      stopTest() // nobody's watching the camera — stop producing frames
    }
  }, 3000).unref?.()

  // Server-side rate instrumentation (read via cameraStats()/GET stats): source-fps =
  // how fast NEW frames actually arrive from the source (a new Buffer ref), sent-fps =
  // frames we push. If both sit at ~13 while the device also reads 13, the cap is upstream.
  let sentFrames = 0
  let sourceFrames = 0
  let lastFrameRef: Buffer | null = null
  setInterval(() => {
    statsSourceFps = sourceFrames / 2
    statsSentFps = sentFrames / 2
    statsSubs = subs.size
    sentFrames = 0
    sourceFrames = 0
  }, 2000).unref?.()

  // PACED sender. The bottleneck is BURSTY fragment loss on the C6/SDIO bridge: dumping
  // a whole frame's ~20+ datagrams at once overflows the co-processor's inbound buffer.
  // The pipe itself is fine (~36 Mbps); we just must not deliver a fragment-bomb. So we
  // send BATCH datagrams, pause PACE_MS, repeat — spreading a frame across the interval
  // so the C6 drains between bursts. Same bytes, intact. (Tune via env if needed.)
  let frameId = 0
  void (async () => {
    for (;;) {
      for (const [k, v] of subs) if (Date.now() - v.last > SUB_TTL_MS) subs.delete(k)
      const targets = [...subs.values()]
      // Only stream when a device is in camera-test mode AND a source is producing
      // frames; otherwise the screen is on the clock/touch page and wants nothing.
      const frame = (targets.length && isTestActive() && anyDeviceInCameraMode()) ? latestTestFrame() : null
      // DEDUP: only transmit when the source produced a NEW frame. No duplicate sends, so
      // sent-fps == source-fps and loss% (sent vs device-received) is meaningful.
      if (frame && frame !== lastFrameRef) {
        lastFrameRef = frame
        sourceFrames++
        const cnt = Math.ceil(frame.length / FRAG)
        if (cnt <= 255) {
          frameId = (frameId + 1) & 0xffff
          sentFrames++
          for (let i = 0; i < cnt; i++) {
            const start = i * FRAG
            const end = Math.min(start + FRAG, frame.length)
            const pkt = Buffer.allocUnsafe(4 + (end - start))
            pkt[0] = frameId & 0xff
            pkt[1] = (frameId >> 8) & 0xff
            pkt[2] = i
            pkt[3] = cnt
            frame.copy(pkt, 4, start, end)
            for (const v of targets) sock.send(pkt, v.port, v.addr)
            if (PACE_MS > 0 && i % BATCH === BATCH - 1) await sleep(PACE_MS)
          }
        }
      }
      await sleep(POLL_MS) // poll faster than the source so each new frame goes out promptly
    }
  })()

  // ── Ambient DISPLAY sender ─────────────────────────────────────────────────────
  // In NORMAL mode (not camera-test), push each subscribed device its OWN server-
  // rendered layout frame over this same UDP path, so the Tab5 hardware-decodes it
  // (hw_jpeg) and blits it on the clock page — this is how layout/theme edits actually
  // reach the device. Paced like the camera sender to avoid the C6 fragment-bomb.
  const sendFrame = async (frame: Buffer, target: Sub): Promise<void> => {
    const cnt = Math.ceil(frame.length / FRAG)
    if (cnt > 255) return
    frameId = (frameId + 1) & 0xffff
    for (let i = 0; i < cnt; i++) {
      const start = i * FRAG
      const end = Math.min(start + FRAG, frame.length)
      const pkt = Buffer.allocUnsafe(4 + (end - start))
      pkt[0] = frameId & 0xff
      pkt[1] = (frameId >> 8) & 0xff
      pkt[2] = i
      pkt[3] = cnt
      frame.copy(pkt, 4, start, end)
      sock.send(pkt, target.port, target.addr)
      if (PACE_MS > 0 && i % BATCH === BATCH - 1) await sleep(PACE_MS)
    }
  }
  void (async () => {
    for (;;) {
      await sleep(DISPLAY_MS)
      const now = Date.now()
      for (const v of subs.values()) {
        if (now - v.last > SUB_TTL_MS || !v.mac) continue
        try {
          const dev = await deviceByHwid(v.mac)
          if (!dev) continue
          if (getDeviceMode(dev.id) === 'camera-test') continue // camera sender owns this device
          // Native-LVGL devices draw their own dashboard, so we don't render/stream the
          // DISPLAY view to them (frees the headless-Chromium tab + UDP bandwidth). But the
          // CONTROLLER (stream deck) is still a server-rendered surface, so when the device
          // is swiped into controller view we DO render + stream it.
          if (rendererForTemplateId(dev.layoutTemplateId ?? DEFAULT_TEMPLATE_ID) === 'lvgl'
              && deviceView(dev.id) !== 'controller') continue
          const frame = await captureDeviceFrame(dev.id, dev.userId)
          if (frame) await sendFrame(frame, v)
        } catch { /* a bad render shouldn't kill the loop */ }
      }
    }
  })()
}
