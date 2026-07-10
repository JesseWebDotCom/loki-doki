import { useEffect, useState } from 'react'

// Vision-model availability, from GET /api/vision/status. Fetched once per page
// load (module-level cache shared by every consumer: engine screen-awareness
// gate, composer attach items) since installing a model requires admin action
// and a reload is a fine refresh boundary.

export interface VisionStatus {
  available: boolean
  model: string
}

let cached: VisionStatus | null = null
let inflight: Promise<VisionStatus | null> | null = null

export function fetchVisionStatus(): Promise<VisionStatus | null> {
  if (cached) return Promise.resolve(cached)
  inflight ??= fetch('/api/vision/status', { credentials: 'include' })
    .then((r) => (r.ok ? (r.json() as Promise<VisionStatus>) : null))
    .then((s) => { cached = s; return s })
    .catch(() => null)
    .finally(() => { inflight = null })
  return inflight
}

export function useVisionStatus(): VisionStatus | null {
  const [status, setStatus] = useState<VisionStatus | null>(cached)
  useEffect(() => {
    if (cached) return
    let cancelled = false
    void fetchVisionStatus().then((s) => { if (!cancelled) setStatus(s) })
    return () => { cancelled = true }
  }, [])
  return status
}
