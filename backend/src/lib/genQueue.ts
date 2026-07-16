/**
 * genQueue — generation queue + background persistence
 *
 * Generalises two existing patterns into one typed, generation-agnostic manager:
 *   - image.ts ad-hoc job registry (Map + AbortController + listener Set)
 *   - system.ts boot subscriber/replay (events[] buffer + subscribers Set + broadcast)
 *
 * Key guarantees:
 *   - Disconnect is NEVER a stop signal. A connection only attaches/detaches a subscriber.
 *   - Generation runs to completion regardless of whether a client is connected.
 *   - Token buffer is in-memory only — no per-token DB writes.
 *   - Per-type FIFO lanes; waiting[] is the seam for future per-user round-robin.
 */

import os from 'node:os'
import { logger } from '@/lib/logger'
import { getAppSetting } from '@/lib/settings'
import { releaseCodingGpuForImaging } from '@/lib/codingEngine'

// ── Types ─────────────────────────────────────────────────────────────────────

export type GenType = 'chat' | 'image' | 'vision' | 'convert'
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** One buffered SSE event. seq is monotonic per job — used for cursor-based replay. */
export interface GenEvent {
  seq: number
  event: string
  data: string
}

export interface JobRunContext {
  jobId: string
  signal: AbortSignal
  /** Emit an event to the buffer + all live subscribers. */
  emit: (event: string, data: string) => void
}

export interface Job {
  id: string
  type: GenType
  userId: string
  status: JobStatus
  createdAt: number
  startedAt: number | null
  /** Type-specific metadata: chat → {conversationId, assistantMessageId}; image → {imageId} */
  meta: Record<string, unknown>
  /** In-memory replay buffer. Capped at MAX_BUFFER events. */
  events: GenEvent[]
  subscribers: Set<(e: GenEvent) => void>
  /** Explicit cancel ONLY — never wired to the HTTP connection. */
  abort: AbortController
  run: (ctx: JobRunContext) => Promise<void>
  nextSeq: number
}

export interface QueueSnapshot {
  running: Record<GenType, number>
  queued: Record<GenType, number>
  limits: Record<GenType, number>
  loadAvg: number
  mode: string
}

/** Duck-typed interface for Hono's SSEStreamingApi — avoids importing Hono types here. */
interface SSEStream {
  writeSSE: (event: { event?: string; data: string; id?: string }) => Promise<void>
  onAbort: (fn: () => void) => void
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** ~6500-word generation fits comfortably; a 2048-token response is trivially small. */
const MAX_BUFFER = 8_000

/** Matches the GC window in image.ts */
const GC_DELAY_MS = 60_000

const DEFAULT_LIMITS: Record<GenType, number> = { chat: 2, image: 1, vision: 1, convert: 2 }

// ── Internal state ────────────────────────────────────────────────────────────

const jobs = new Map<string, Job>()

const lanes: Record<GenType, { running: Set<string>; waiting: string[] }> = {
  chat:    { running: new Set(), waiting: [] },
  image:   { running: new Set(), waiting: [] },
  vision:  { running: new Set(), waiting: [] },
  convert: { running: new Set(), waiting: [] },
}

/** Effective limits cache — re-read from app_settings at most once per second */
let limitsCache: { limits: Record<GenType, number>; mode: string; fetchedAt: number } | null = null
const LIMITS_TTL_MS = 1_000

/** Mutable limits used when mode = 'dynamic' */
let dynamicLimits: Record<GenType, number> = { ...DEFAULT_LIMITS }
let dynamicInterval: ReturnType<typeof setInterval> | null = null

// ── Effective limit ────────────────────────────────────────────────────────────

async function readLimitsFromSettings(): Promise<{ limits: Record<GenType, number>; mode: string }> {
  try {
    const mode = (await getAppSetting('queue.mode') as string | null) ?? 'suggested'
    let limits: Record<GenType, number>

    if (mode === 'manual') {
      const manual = await getAppSetting('queue.limits.manual') as Record<GenType, number> | null
      limits = manual ?? { ...DEFAULT_LIMITS }
    } else if (mode === 'dynamic') {
      limits = { ...dynamicLimits }
    } else {
      // 'suggested' — read hwfit-seeded values
      const suggested = await getAppSetting('queue.limits.suggested') as Record<GenType, number> | null
      limits = suggested ?? { ...DEFAULT_LIMITS }
    }

    return { limits, mode }
  } catch {
    return { limits: { ...DEFAULT_LIMITS }, mode: 'suggested' }
  }
}

async function getEffectiveLimit(type: GenType): Promise<number> {
  const now = Date.now()
  if (!limitsCache || now - limitsCache.fetchedAt > LIMITS_TTL_MS) {
    const { limits, mode } = await readLimitsFromSettings()
    limitsCache = { limits, mode, fetchedAt: now }

    // Start/stop dynamic interval based on mode
    if (mode === 'dynamic' && !dynamicInterval) {
      dynamicInterval = startDynamicSampler()
    } else if (mode !== 'dynamic' && dynamicInterval) {
      clearInterval(dynamicInterval)
      dynamicInterval = null
    }
  }
  return limitsCache!.limits[type] ?? DEFAULT_LIMITS[type]
}

function startDynamicSampler(): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      const cfg = await getAppSetting('queue.dynamic') as {
        loadHighWatermark?: number
        loadLowWatermark?: number
        min?: Record<GenType, number>
        max?: Record<GenType, number>
      } | null

      const highWM  = cfg?.loadHighWatermark ?? 0.75
      const lowWM   = cfg?.loadLowWatermark  ?? 0.40
      const minLims = cfg?.min ?? { chat: 1, image: 1, vision: 1, convert: 1 }
      const maxLims = cfg?.max ?? { chat: 4, image: 2, vision: 2, convert: 4 }

      const normalized = os.loadavg()[0] / Math.max(1, os.cpus().length)
      let changed = false

      for (const t of ['chat', 'image', 'vision', 'convert'] as GenType[]) {
        const cur = dynamicLimits[t]
        if (normalized > highWM && cur > minLims[t]) {
          dynamicLimits[t] = cur - 1
          logger.info(`[genQueue] dynamic: ${t} slots ${cur} → ${dynamicLimits[t]} (load=${normalized.toFixed(2)})`)
          changed = true
        } else if (normalized < lowWM && cur < maxLims[t]) {
          dynamicLimits[t] = cur + 1
          logger.info(`[genQueue] dynamic: ${t} slots ${cur} → ${dynamicLimits[t]} (load=${normalized.toFixed(2)})`)
          changed = true
        }
      }

      // Invalidate cache so next getEffectiveLimit picks up the new values
      limitsCache = null

      // A slot opened — try to start queued jobs
      if (changed) void pumpAll()
    } catch { /* non-fatal */ }
  }, 5_000)
}

// ── Core helpers ─────────────────────────────────────────────────────────────

function appendAndFanout(job: Job, event: string, data: string): void {
  const e: GenEvent = { seq: job.nextSeq++, event, data }
  job.events.push(e)

  // Cap buffer — trim oldest when over limit
  if (job.events.length > MAX_BUFFER) {
    job.events.splice(0, job.events.length - MAX_BUFFER)
  }

  // Fan out to live subscribers; self-remove dead ones (Bun write-failure mitigation)
  const dead: Array<(e: GenEvent) => void> = []
  for (const fn of job.subscribers) {
    try { fn(e) } catch { dead.push(fn) }
  }
  for (const fn of dead) job.subscribers.delete(fn)
}

function rebroadcastPositions(type: GenType): void {
  lanes[type].waiting.forEach((id, idx) => {
    const job = jobs.get(id)
    if (job) appendAndFanout(job, 'queue', JSON.stringify({ position: idx + 1, type }))
  })
}

async function runJob(job: Job): Promise<void> {
  const type = job.type
  job.status = 'running'
  job.startedAt = Date.now()

  // Imaging handoff: image generation shares its GPU with the coding engine. When nobody
  // is actively coding, release the coding model first so ComfyUI gets the whole card
  // (awaited - the unload is fast and the VRAM must actually be free before the job runs).
  if (type === 'image') {
    await releaseCodingGpuForImaging().catch(() => {})
  }

  // Notify subscribers that the slot is acquired
  appendAndFanout(job, 'queue', JSON.stringify({ position: 0, type }))

  const ctx: JobRunContext = {
    jobId: job.id,
    signal: job.abort.signal,
    emit: (event, data) => appendAndFanout(job, event, data),
  }

  try {
    await job.run(ctx)
    if (job.status === 'running') job.status = 'done'
  } catch (err) {
    if (job.status === 'running') {
      job.status = 'error'
      appendAndFanout(job, 'error', String(err))
    }
  } finally {
    lanes[type].running.delete(job.id)
    setTimeout(() => jobs.delete(job.id), GC_DELAY_MS)
    // Slot freed — kick the scheduler to start the next queued job
    void pump(type)
    // Stop the dynamic sampler once the queue is fully idle, so an idle server
    // doesn't keep an interval ticking forever. It restarts on the next
    // getEffectiveLimit() call while still in dynamic mode.
    stopDynamicSamplerIfIdle()
  }
}

/** True when no lane has a running or waiting job. */
function isQueueIdle(): boolean {
  return (['chat', 'image', 'vision', 'convert'] as GenType[]).every(
    (t) => lanes[t].running.size === 0 && lanes[t].waiting.length === 0,
  )
}

/** Clear the dynamic-limit sampler interval when the queue goes idle. */
function stopDynamicSamplerIfIdle(): void {
  if (dynamicInterval && isQueueIdle()) {
    clearInterval(dynamicInterval)
    dynamicInterval = null
  }
}

async function pump(type: GenType): Promise<void> {
  const lane = lanes[type]
  const limit = await getEffectiveLimit(type)

  while (lane.running.size < limit && lane.waiting.length > 0) {
    const id = lane.waiting.shift()!
    const job = jobs.get(id)
    if (!job || job.status === 'cancelled') continue
    lane.running.add(id)
    void runJob(job)  // detached — fire and forget
  }
  rebroadcastPositions(type)
}

async function pumpAll(): Promise<void> {
  await Promise.all((['chat', 'image', 'vision', 'convert'] as GenType[]).map(pump))
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface EnqueueParams {
  type: GenType
  userId: string
  meta: Record<string, unknown>
  run: (ctx: JobRunContext) => Promise<void>
}

/** Thrown by enqueue() when a user already has too many queued jobs in a lane. */
export class QueueLimitError extends Error {
  constructor(message = 'Too many queued requests') {
    super(message)
    this.name = 'QueueLimitError'
  }
}

// Cap how many CHAT jobs one user can have WAITING, so a single user can't stack
// unbounded chat generations (running jobs are already bounded by the lane limits).
// Scoped to the chat lane: image/vision are gated by their own UIs and callers
// don't expect enqueue to reject.
const MAX_CHAT_WAITING_PER_USER = 3

/** Register a generation job. Returns immediately; the job runs in the background. */
export function enqueue(params: EnqueueParams): Job {
  if (params.type === 'chat') {
    const chatLane = lanes.chat
    const userWaiting = chatLane.waiting.reduce(
      (n, id) => (jobs.get(id)?.userId === params.userId ? n + 1 : n),
      0,
    )
    if (userWaiting >= MAX_CHAT_WAITING_PER_USER) {
      throw new QueueLimitError()
    }
  }

  const job: Job = {
    id: crypto.randomUUID(),
    type: params.type,
    userId: params.userId,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    meta: params.meta,
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
    run: params.run,
    nextSeq: 0,
  }
  jobs.set(job.id, job)

  const lane = lanes[params.type]
  lane.waiting.push(job.id)

  // Emit initial queue position so the first subscriber sees it on replay
  const position = lane.waiting.length
  appendAndFanout(job, 'queue', JSON.stringify({ position, type: params.type }))

  void pump(params.type)

  return job
}

/** Look up a job by ID. */
export function get(id: string): Job | undefined {
  return jobs.get(id)
}

/** Find a running/recent job by a metadata key/value pair. */
export function findByMeta(key: string, value: unknown): Job | undefined {
  for (const job of jobs.values()) {
    if (job.meta[key] === value) return job
  }
  return undefined
}

/** Find a QUEUED or RUNNING job by metadata — used to serialize per-conversation turns. */
export function findActiveByMeta(key: string, value: unknown): Job | undefined {
  for (const job of jobs.values()) {
    if (job.meta[key] === value && (job.status === 'queued' || job.status === 'running')) return job
  }
  return undefined
}

/** Cancel a job. Only the owning user can cancel. Returns false if not found/forbidden. */
export function cancel(jobId: string, userId: string): boolean {
  const job = jobs.get(jobId)
  if (!job) return false
  if (job.userId !== userId) return false

  job.abort.abort()
  if (job.status !== 'running') {
    // Remove from waiting queue
    const lane = lanes[job.type]
    const idx = lane.waiting.indexOf(jobId)
    if (idx !== -1) lane.waiting.splice(idx, 1)
    appendAndFanout(job, 'cancelled', JSON.stringify({ jobId }))
    rebroadcastPositions(job.type)
    setTimeout(() => jobs.delete(jobId), GC_DELAY_MS)
    // Cancelling the last queued job may leave the queue idle.
    stopDynamicSamplerIfIdle()
  }
  job.status = 'cancelled'
  return true
}

/** Get the queue position of a job. Returns null if not queued. */
export function positionOf(jobId: string): { type: GenType; position: number } | null {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'queued') return null
  const pos = lanes[job.type].waiting.indexOf(jobId)
  return pos === -1 ? null : { type: job.type, position: pos + 1 }
}

/** Admin snapshot of current queue state. */
export async function snapshot(): Promise<QueueSnapshot> {
  const { limits, mode } = await readLimitsFromSettings()
  return {
    running: {
      chat:    lanes.chat.running.size,
      image:   lanes.image.running.size,
      vision:  lanes.vision.running.size,
      convert: lanes.convert.running.size,
    },
    queued: {
      chat:    lanes.chat.waiting.length,
      image:   lanes.image.waiting.length,
      vision:  lanes.vision.waiting.length,
      convert: lanes.convert.waiting.length,
    },
    limits,
    loadAvg: os.loadavg()[0] / Math.max(1, os.cpus().length),
    mode,
  }
}

/** Get the current effective limit for a type. */
export async function getLimit(type: GenType): Promise<number> {
  return getEffectiveLimit(type)
}

/**
 * subscribeAndTail — the shared catch-up + live-tail primitive for route handlers.
 *
 * Pattern (single-threaded JS safe):
 *  1. Subscribe live listener FIRST (captures events emitted during async replay)
 *  2. Replay historical events (seq >= sinceSeq) through a serial write chain
 *  3. Live events append to the same serial chain → no gaps, no duplicates
 *  4. stream.onAbort unsubscribes only — never aborts the job
 */
export async function subscribeAndTail(
  stream: SSEStream,
  job: Job,
  sinceSeq: number,
): Promise<void> {
  let settled = false
  let resolve!: () => void
  const done = new Promise<void>(r => { resolve = r })

  // Serial write chain — serialises concurrent live events against async replay writes
  let writeChain = Promise.resolve()

  function enqueueWrite(e: GenEvent): void {
    writeChain = writeChain.then(async () => {
      if (settled) return
      try {
        await stream.writeSSE({ event: e.event, data: e.data, id: String(e.seq) })
        if (e.event === 'done' || e.event === 'error' || e.event === 'cancelled') {
          job.subscribers.delete(liveListener)
          settled = true
          resolve()
        }
      } catch {
        // Client disconnected — unsubscribe, settle promise, but DO NOT abort the job
        job.subscribers.delete(liveListener)
        settled = true
        resolve()
      }
    })
  }

  // Subscribe live FIRST so no events are lost during async replay below
  function liveListener(e: GenEvent): void {
    enqueueWrite(e)
  }

  if (job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled') {
    job.subscribers.add(liveListener)
  }

  // Replay historical events into the serial chain
  for (const e of [...job.events]) {
    if (e.seq >= sinceSeq) enqueueWrite(e)
  }

  // If already terminal and replay has the done/error event, resolve after chain drains
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    writeChain = writeChain.then(() => {
      if (!settled) { settled = true; resolve() }
    })
  }

  // Disconnect only unsubscribes — never cancels the job
  stream.onAbort(() => {
    job.subscribers.delete(liveListener)
    if (!settled) { settled = true; resolve() }
  })

  await done
}
