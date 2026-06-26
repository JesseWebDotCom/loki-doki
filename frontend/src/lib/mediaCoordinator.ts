// Mutual exclusion for app-wide audio sources. Each media context registers a
// stop callback; any source that wants exclusive audio calls acquireAudio() first.

type StopFn = () => void
const stops: Partial<Record<'radio' | 'youtube', StopFn>> = {}

export function registerMediaStop(kind: 'radio' | 'youtube', fn: StopFn): () => void {
  stops[kind] = fn
  return () => { if (stops[kind] === fn) delete stops[kind] }
}

export function acquireAudio(source: 'radio' | 'youtube'): void {
  for (const [kind, fn] of Object.entries(stops) as [string, StopFn][]) {
    if (kind !== source) fn()
  }
}
