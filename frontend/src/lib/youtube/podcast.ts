// Shared state for the "create podcast from YouTube" flow.

export const DEFAULT_BATCH = 5
export const MAX_BATCH = 25
const BATCH_KEY = 'yt.podcast.batchSize'

/** How many episodes to generate per batch (persisted setting, 1–25, default 5). */
export function getBatchSize(): number {
  const n = Number(localStorage.getItem(BATCH_KEY))
  return Number.isFinite(n) && n >= 1 && n <= MAX_BATCH ? n : DEFAULT_BATCH
}

export function setBatchSize(n: number) {
  try { localStorage.setItem(BATCH_KEY, String(Math.min(MAX_BATCH, Math.max(1, Math.round(n))))) } catch { /* quota */ }
}
