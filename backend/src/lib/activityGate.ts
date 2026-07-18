// Priority ladder (Phase 3.10 + 3.12 of docs/internal/resource-management-plan.md).
// Interactive work (a live chat or voice turn) always wins. Background GPU/CPU
// hogs (podcast transcription on the shared Whisper sidecar, stems separation, the
// memory-judge LLM sweep) call waitForInteractiveIdle() before they start, so they
// never lag a conversation. The wait is BOUNDED: after maxWaitMs it proceeds anyway,
// so a chatty household can never starve background work forever.
//
// It intentionally gates at job START, not mid-operation: a single long-form
// transcription runs to completion once launched. Marking every turn keeps
// "interactive" hot across a conversation's gaps, so a queued background job waits
// out the conversation rather than interleaving with it.

import { logger } from '@/lib/logger'

let lastInteractiveAt = 0

/** Call at the start of any live chat / voice turn. Cheap (a timestamp). */
export function markInteractive(): void {
  lastInteractiveAt = Date.now()
}

/** Milliseconds since the last interactive turn (Infinity if none this process). */
export function interactiveIdleMs(): number {
  return lastInteractiveAt === 0 ? Infinity : Date.now() - lastInteractiveAt
}

export interface YieldOpts {
  /** Required quiet window before proceeding (ms). Default 1500. */
  quietMs?: number
  /** Hard ceiling on how long we defer (ms), so background work never starves.
   *  Default 20s. */
  maxWaitMs?: number
  /** Poll interval while waiting (ms). Default 500. */
  pollMs?: number
  /** For the log line, e.g. 'podcast-transcribe'. */
  label?: string
}

/**
 * Resolve once there has been no interactive turn for `quietMs`, or `maxWaitMs`
 * elapses (whichever comes first). Background jobs await this before heavy work so a
 * live conversation stays snappy. Never throws; never blocks longer than maxWaitMs.
 */
export async function waitForInteractiveIdle(opts: YieldOpts = {}): Promise<void> {
  const quietMs = opts.quietMs ?? 1500
  const maxWaitMs = opts.maxWaitMs ?? 20_000
  const pollMs = opts.pollMs ?? 500
  const deadline = Date.now() + maxWaitMs
  let waited = false
  while (interactiveIdleMs() < quietMs && Date.now() < deadline) {
    waited = true
    await new Promise((r) => setTimeout(r, pollMs))
  }
  if (waited && opts.label) {
    const proceededOnTimeout = Date.now() >= deadline
    logger.info(`[resource] ${opts.label} ${proceededOnTimeout ? 'proceeding after max wait (still interactive)' : 'proceeding, conversation went idle'}`)
  }
}
