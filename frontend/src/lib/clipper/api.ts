// Clipper API client. Mirrors lib/podcast/api.ts's shape (typed fetch wrappers,
// credentials: 'include', throw-on-error). See backend/src/routes/clipper.ts for the contract.

export interface ClipFormat {
  formatId: string
  ext: string
  resolution: string
  note: string
  protocol: string
  vcodec: string
  acodec: string
  filesize: number | null
}

/** Response from POST /resolve, a preview only (no DB write). */
export interface ClipPreview {
  title: string
  thumbnailUrl: string | null
  durationSeconds: number | null
  extractor: string | null
  formats: ClipFormat[]
}

export type ClipKind = 'audio' | 'video'
export type ClipStatus = 'pending' | 'downloading' | 'ready' | 'failed'

/** A saved clip row (GET /list). */
export interface Clip {
  id: string
  userId: string
  sourceUrl: string
  extractor: string | null
  title: string
  thumbnailUrl: string | null
  durationSeconds: number | null
  kind: ClipKind
  status: ClipStatus
  assetId: string | null
  sizeBytes: number | null
  error: string | null
  createdAt: string | number
  updatedAt: string | number
}

const J = { 'Content-Type': 'application/json' }
const opts: RequestInit = { credentials: 'include' }

export async function resolveClipUrl(url: string): Promise<ClipPreview> {
  const r = await fetch('/api/clipper/resolve', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ url }) })
  const d = await r.json().catch(() => ({})) as Partial<ClipPreview> & { ok?: boolean; error?: string }
  if (!r.ok || !d.ok) throw new Error(d.error ?? 'Could not resolve that link')
  return {
    title: d.title ?? '',
    thumbnailUrl: d.thumbnailUrl ?? null,
    durationSeconds: d.durationSeconds ?? null,
    extractor: d.extractor ?? null,
    formats: d.formats ?? [],
  }
}

/** Quick direct-play probe: a 1-byte Range request so we only pay for headers, not the
 *  whole file, then cancel the body. Returns false on the route's 409 no-direct-play sentinel. */
export async function checkDirectPlay(url: string): Promise<boolean> {
  try {
    const r = await fetch(clipStreamUrl(url), { ...opts, headers: { Range: 'bytes=0-0' } })
    if (r.status === 409) return false
    void r.body?.cancel().catch(() => {})
    return r.ok
  } catch {
    return false
  }
}

export function clipStreamUrl(sourceUrl: string): string {
  return `/api/clipper/stream?url=${encodeURIComponent(sourceUrl)}`
}

export function clipFileUrl(clipId: string): string {
  return `/api/clipper/file/${clipId}`
}

export interface SaveClipInput {
  url: string
  kind: ClipKind
  title?: string
  thumbnailUrl?: string | null
  durationSeconds?: number | null
  extractor?: string | null
}

export async function saveClip(input: SaveClipInput): Promise<{ id: string }> {
  const r = await fetch('/api/clipper/save', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  const d = await r.json().catch(() => ({})) as { ok?: boolean; id?: string; error?: string }
  if (!r.ok || !d.ok || !d.id) throw new Error(d.error ?? 'Could not save that clip')
  return { id: d.id }
}

export async function listClips(): Promise<Clip[]> {
  const r = await fetch('/api/clipper/list', opts)
  if (!r.ok) throw new Error('clips')
  return (await r.json() as { clips: Clip[] }).clips ?? []
}
