// Real connection speed test, modelled on the LibreSpeed methodology:
// multiple concurrent streams, a grace/warmup period to let the TCP window
// ramp before measuring, HTTP ping/jitter, and a x1.06 overhead compensation.
//
// Three modes:
//   internet         — true ISP speed against Cloudflare's edge (client-driven)
//   server           — private throughput to your own Loki Doki server (client-driven)
//   server-internet  — server's own internet speed against Cloudflare (server-driven SSE)

// ── Modes & providers ───────────────────────────────────────────────────────

export type SpeedMode = 'internet' | 'server' | 'server-internet'

interface Provider {
  downloadUrl: string
  uploadUrl: string
  pingUrl: string
  credentials: RequestCredentials
  dlStreams: number
  ulStreams: number
  dlBytes: number
  ulBytes: number
}

const MB = 1024 * 1024

const PROVIDERS: Record<'internet' | 'server', Provider> = {
  internet: {
    downloadUrl: 'https://speed.cloudflare.com/__down',
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'https://speed.cloudflare.com/__down',
    credentials: 'omit',
    dlStreams: 6,
    ulStreams: 6,
    dlBytes: 25 * MB,
    ulBytes: 1 * MB,
  },
  server: {
    downloadUrl: '/api/speedtest/download',
    uploadUrl: '/api/speedtest/upload',
    pingUrl: '/api/speedtest/ping',
    credentials: 'include',
    dlStreams: 4,
    ulStreams: 4,
    dlBytes: 50 * MB,
    ulBytes: 2 * MB,
  },
}

export const MODE_META: Record<SpeedMode, { label: string; tagline: string }> = {
  internet:        { label: 'Internet',        tagline: 'Real ISP speed via Cloudflare edge' },
  server:          { label: 'Server',           tagline: 'Private throughput to your server' },
  'server-internet': { label: 'Server Internet', tagline: "Server's internet speed via Cloudflare edge" },
}

// Tuning (milliseconds / counts).
const OVERHEAD = 1.06
const PING_COUNT = 9
const GRACE_DL = 1200
const MEASURE_DL = 6000
const GRACE_UL = 1500
const MEASURE_UL = 6000
const TICK_MS = 120

// ── Thresholds & rating ─────────────────────────────────────────────────────

export interface SpeedThresholds {
  /** At or above this download speed (Mbps) the result is rated good (green). */
  goodMbps: number
  /** At or above this (and below good) the result is rated ok (yellow). Below = bad (red). */
  okMbps: number
}

export const DEFAULT_THRESHOLDS: SpeedThresholds = { goodMbps: 50, okMbps: 10 }

export const LAST_RESULT_PREF_KEY = 'speedtest.last'
export const MODE_PREF_KEY = 'speedtest.mode'

export type SpeedRating = 'good' | 'ok' | 'bad'

export const RATING_META: Record<SpeedRating, { label: string; color: string; text: string; bg: string; ring: string }> = {
  // color: raw hex feeds the gauge-needle inline style (canvas/SVG-style DOM paint), not a Tailwind class.
  good: { label: 'Good', color: '#22c55e', text: 'text-success', bg: 'bg-success/10', ring: 'ring-success/30' },
  ok:   { label: 'OK',   color: '#f59e0b', text: 'text-warning', bg: 'bg-warning/10', ring: 'ring-warning/30' },
  bad:  { label: 'Slow', color: '#ef4444', text: 'text-destructive', bg: 'bg-destructive/10', ring: 'ring-destructive/30' },
}

export function rateSpeed(mbps: number, t: SpeedThresholds): SpeedRating {
  if (mbps >= t.goodMbps) return 'good'
  if (mbps >= t.okMbps) return 'ok'
  return 'bad'
}

export function normalizeThresholds(raw: unknown): SpeedThresholds {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_THRESHOLDS }
  const r = raw as Partial<SpeedThresholds>
  const good = Number.isFinite(r.goodMbps) ? Math.max(0, Number(r.goodMbps)) : DEFAULT_THRESHOLDS.goodMbps
  const ok = Number.isFinite(r.okMbps) ? Math.max(0, Number(r.okMbps)) : DEFAULT_THRESHOLDS.okMbps
  return { goodMbps: Math.max(good, ok), okMbps: Math.min(good, ok) }
}

// ── Thresholds — admin-controlled, readable by all ─────────────────────────

export async function loadThresholds(): Promise<SpeedThresholds> {
  try {
    const r = await fetch('/api/admin/speedtest', { credentials: 'include' })
    if (!r.ok) return { ...DEFAULT_THRESHOLDS }
    return normalizeThresholds(await r.json())
  } catch {
    return { ...DEFAULT_THRESHOLDS }
  }
}

export async function saveThresholds(thresholds: SpeedThresholds): Promise<unknown> {
  return fetch('/api/admin/speedtest', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(thresholds),
  }).catch(() => undefined)
}

// ── Result shape & persistence ──────────────────────────────────────────────

export interface SpeedResult {
  mode: SpeedMode
  downloadMbps: number
  uploadMbps: number
  pingMs: number
  jitterMs: number
  at: number
}

async function loadPrefs(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`/api/users/${userId}/preferences`, { credentials: 'include' })
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function savePref(userId: string, key: string, value: unknown): Promise<unknown> {
  return fetch(`/api/users/${userId}/preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => undefined)
}

export async function loadMode(userId: string): Promise<SpeedMode> {
  const m = (await loadPrefs(userId))?.[MODE_PREF_KEY]
  if (m === 'server' || m === 'server-internet') return m
  return 'internet'
}

export function saveMode(userId: string, mode: SpeedMode): Promise<unknown> {
  return savePref(userId, MODE_PREF_KEY, mode)
}

export type ResultsByMode = { internet: SpeedResult | null; server: SpeedResult | null; 'server-internet': SpeedResult | null }

function parseResult(raw: unknown): SpeedResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<SpeedResult>
  if (!Number.isFinite(r.downloadMbps)) return null
  let mode: SpeedMode = 'internet'
  if (r.mode === 'server') mode = 'server'
  else if (r.mode === 'server-internet') mode = 'server-internet'
  return {
    mode,
    downloadMbps: Number(r.downloadMbps),
    uploadMbps: Number(r.uploadMbps ?? 0),
    pingMs: Number(r.pingMs ?? 0),
    jitterMs: Number(r.jitterMs ?? 0),
    at: Number(r.at ?? 0),
  }
}

/** Read all modes' last results. */
export async function loadLastResults(userId: string): Promise<ResultsByMode> {
  const raw = (await loadPrefs(userId))?.[LAST_RESULT_PREF_KEY]
  const out: ResultsByMode = { internet: null, server: null, 'server-internet': null }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  if ('internet' in obj || 'server' in obj || 'server-internet' in obj) {
    out.internet = parseResult(obj.internet)
    out.server = parseResult(obj.server)
    out['server-internet'] = parseResult(obj['server-internet'])
  } else {
    const single = parseResult(raw)
    if (single) out[single.mode] = single
  }
  return out
}

/** Newest result across modes (used by the home widget). */
export async function loadLastResult(userId: string): Promise<SpeedResult | null> {
  const { internet, server, 'server-internet': si } = await loadLastResults(userId)
  const all = [internet, server, si].filter(Boolean) as SpeedResult[]
  if (!all.length) return null
  return all.reduce((a, b) => a.at >= b.at ? a : b)
}

export function saveLastResults(userId: string, results: ResultsByMode): Promise<unknown> {
  return savePref(userId, LAST_RESULT_PREF_KEY, results)
}

/** Merge a single mode's result into the stored pair (used by the home widget). */
export async function saveLastResult(userId: string, result: SpeedResult): Promise<unknown> {
  const cur = await loadLastResults(userId)
  cur[result.mode] = result
  return saveLastResults(userId, cur)
}

// ── Measurement primitives ──────────────────────────────────────────────────

function withParam(url: string, kv: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${kv}`
}

function rnd(): string {
  return Math.random().toString(36).slice(2)
}

async function measurePing(p: Provider, onSample: (ms: number) => void): Promise<{ pingMs: number; jitterMs: number }> {
  const samples: number[] = []
  for (let i = 0; i < PING_COUNT; i++) {
    const target = withParam(withParam(p.pingUrl, 'bytes=0'), `r=${rnd()}`)
    const start = performance.now()
    try {
      const res = await fetch(target, { credentials: p.credentials, cache: 'no-store' })
      // Drain so keep-alive can be reused on the next ping.
      await res.arrayBuffer().catch(() => undefined)
    } catch {
      continue
    }
    const rtt = performance.now() - start
    if (i > 0) {
      samples.push(rtt) // discard the first (connection warmup)
      onSample(Math.min(...samples))
    }
  }
  if (samples.length === 0) return { pingMs: 0, jitterMs: 0 }
  const pingMs = Math.min(...samples)
  let jitter = 0
  for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i]! - samples[i - 1]!)
  const jitterMs = samples.length > 1 ? jitter / (samples.length - 1) : 0
  return { pingMs, jitterMs }
}

async function downloadStream(p: Provider, add: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const url = withParam(withParam(p.downloadUrl, `bytes=${p.dlBytes}`), `r=${rnd()}`)
      const res = await fetch(url, { credentials: p.credentials, cache: 'no-store', signal })
      if (!res.body) {
        const buf = await res.arrayBuffer()
        add(buf.byteLength)
        continue
      }
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) add(value.byteLength)
      }
    } catch {
      if (signal.aborted) return
    }
  }
}

function measureDownload(p: Provider, onProgress: (mbps: number, frac: number) => void): Promise<number> {
  const controller = new AbortController()
  let total = 0
  for (let i = 0; i < p.dlStreams; i++) void downloadStream(p, (b) => { total += b }, controller.signal)

  return new Promise((resolve) => {
    const startWall = performance.now()
    let graceOver = false
    let measureStart = 0
    let base = 0
    let last = 0
    const iv = setInterval(() => {
      const now = performance.now()
      if (!graceOver) {
        onProgress(0, (now - startWall) / (GRACE_DL + MEASURE_DL))
        if (now - startWall >= GRACE_DL) { graceOver = true; measureStart = now; base = total }
        return
      }
      const secs = (now - measureStart) / 1000
      last = secs > 0 ? ((total - base) * 8 / secs / 1e6) * OVERHEAD : 0
      onProgress(last, Math.min((now - startWall) / (GRACE_DL + MEASURE_DL), 1))
      if (now - measureStart >= MEASURE_DL) { clearInterval(iv); controller.abort(); resolve(last) }
    }, TICK_MS)
  })
}

function makeBlob(size: number): Blob {
  const seed = new Uint8Array(64 * 1024)
  crypto.getRandomValues(seed)
  const out = new Uint8Array(size)
  for (let off = 0; off < size; off += seed.length) {
    out.set(seed.subarray(0, Math.min(seed.length, size - off)), off)
  }
  // No blob type → no Content-Type header → the cross-origin POST stays a CORS
  // "simple request" with no preflight. (Attaching xhr.upload progress handlers
  // would force a preflight that Cloudflare's __up rejects, which is why we
  // measure by counting completed POSTs via fetch instead.)
  return new Blob([out])
}

// One POST stream: repeatedly upload the same blob, crediting its full size on
// each completed request. Coarser than per-byte progress, but it avoids the
// preflight that kills cross-origin uploads and still saturates with N streams.
async function uploadStream(p: Provider, blob: Blob, add: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await fetch(withParam(p.uploadUrl, `r=${rnd()}`), {
        method: 'POST', body: blob, credentials: p.credentials, cache: 'no-store', signal,
      })
      add(p.ulBytes)
    } catch {
      if (signal.aborted) return
    }
  }
}

function measureUpload(p: Provider, onProgress: (mbps: number, frac: number) => void): Promise<number> {
  const controller = new AbortController()
  const blob = makeBlob(p.ulBytes)
  let total = 0
  for (let i = 0; i < p.ulStreams; i++) void uploadStream(p, blob, (b) => { total += b }, controller.signal)

  return new Promise((resolve) => {
    const startWall = performance.now()
    let graceOver = false
    let measureStart = 0
    let base = 0
    let last = 0
    const iv = setInterval(() => {
      const now = performance.now()
      if (!graceOver) {
        onProgress(0, (now - startWall) / (GRACE_UL + MEASURE_UL))
        if (now - startWall >= GRACE_UL) { graceOver = true; measureStart = now; base = total }
        return
      }
      const secs = (now - measureStart) / 1000
      last = secs > 0 ? ((total - base) * 8 / secs / 1e6) * OVERHEAD : 0
      onProgress(last, Math.min((now - startWall) / (GRACE_UL + MEASURE_UL), 1))
      if (now - measureStart >= MEASURE_UL) { clearInterval(iv); controller.abort(); resolve(last) }
    }, TICK_MS)
  })
}

// ── Server-internet mode (SSE from the backend) ─────────────────────────────

async function runServerInternetTest(onProgress: (p: SpeedProgress) => void): Promise<SpeedResult> {
  const response = await fetch('/api/speedtest/server-internet/stream', { credentials: 'include' })
  if (!response.body) throw new Error('No response body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let eventName = ''
  let eventData = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let nlIdx
    while ((nlIdx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nlIdx).trimEnd()
      buf = buf.slice(nlIdx + 1)

      if (line === '') {
        if (eventData) {
          try {
            const p = JSON.parse(eventData) as SpeedProgress
            onProgress(p)
            if (eventName === 'done') {
              void reader.cancel()
              return {
                mode: 'server-internet',
                downloadMbps: p.downloadMbps,
                uploadMbps: 0,
                pingMs: p.pingMs,
                jitterMs: p.jitterMs,
                at: Date.now(),
              }
            }
          } catch { /* */ }
        }
        eventName = ''
        eventData = ''
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        eventData = line.slice(5).trim()
      }
    }
  }

  throw new Error('Server internet test ended without a result')
}

// ── Orchestration ───────────────────────────────────────────────────────────

export type SpeedPhase = 'idle' | 'ping' | 'download' | 'upload' | 'done'

export interface SpeedProgress {
  phase: SpeedPhase
  /** Live speed (Mbps) for the active phase, or 0 during ping. */
  mbps: number
  /** 0..1 progress within the active phase. */
  frac: number
  pingMs: number
  jitterMs: number
  downloadMbps: number
  uploadMbps: number
}

export async function runSpeedTest(mode: SpeedMode, onProgress: (p: SpeedProgress) => void): Promise<SpeedResult> {
  if (mode === 'server-internet') {
    onProgress({ phase: 'ping', mbps: 0, frac: 0, pingMs: 0, jitterMs: 0, downloadMbps: 0, uploadMbps: 0 })
    return runServerInternetTest(onProgress)
  }

  const p = PROVIDERS[mode]
  const acc = { pingMs: 0, jitterMs: 0, downloadMbps: 0, uploadMbps: 0 }
  const emit = (phase: SpeedPhase, mbps: number, frac: number) =>
    onProgress({ phase, mbps, frac, ...acc })

  emit('ping', 0, 0)
  const ping = await measurePing(p, (ms) => { acc.pingMs = ms; emit('ping', 0, 0.5) })
  acc.pingMs = ping.pingMs
  acc.jitterMs = ping.jitterMs

  emit('download', 0, 0)
  acc.downloadMbps = await measureDownload(p, (mbps, frac) => {
    acc.downloadMbps = mbps
    emit('download', mbps, frac)
  })

  emit('upload', 0, 0)
  acc.uploadMbps = await measureUpload(p, (mbps, frac) => {
    acc.uploadMbps = mbps
    emit('upload', mbps, frac)
  })

  const result: SpeedResult = { mode, ...acc, at: Date.now() }
  emit('done', acc.downloadMbps, 1)
  return result
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function fmtMbps(mbps: number): string {
  if (!Number.isFinite(mbps) || mbps <= 0) return '0'
  if (mbps >= 100) return Math.round(mbps).toString()
  if (mbps >= 10) return mbps.toFixed(1)
  return mbps.toFixed(2)
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0'
  return Math.round(ms).toString()
}
