import { logger } from '@/lib/logger'

// Public iCloud Shared Album reader (Photo Frame app). This is the zero-credential
// road from the research doc: albums shared with a public link expose a JSON API at
// p{NN}-sharedstreams.icloud.com keyed only by the share token (the fragment after
// '#' in the icloud.com/sharedalbum link). No Apple account, no ASP, unaffected by
// Advanced Data Protection. Server-side fetch keeps tokens out of client code and
// lets us cache; the returned CDN URLs are short-lived, so consumers re-pull rather
// than persist them. Env-overridable base for fixture tests (ICLOUD_STREAMS_BASE).

const STREAMS_BASE = process.env.ICLOUD_STREAMS_BASE ?? null   // e.g. http://localhost:9009 in tests
const DEFAULT_PARTITION = 'p23'
const CACHE_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 10_000

export interface SharedAlbumPhoto {
  guid: string
  url: string
  width: number
  height: number
  caption: string | null
  createdAt: string | null
  isVideo: boolean
}

export interface SharedAlbum {
  name: string | null
  photos: SharedAlbumPhoto[]
}

interface WebstreamPhoto {
  photoGuid: string
  caption?: string
  dateCreated?: string
  mediaAssetType?: string
  derivatives?: Record<string, { checksum?: string; width?: string | number; height?: string | number }>
}

function baseUrl(partition: string, token: string): string {
  if (STREAMS_BASE) return `${STREAMS_BASE}/${token}/sharedstreams`
  return `https://${partition}-sharedstreams.icloud.com/${token}/sharedstreams`
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

/** POST webstream, following Apple's 330 partition redirect (X-Apple-MMe-Host). */
async function webstream(token: string): Promise<{ partition: string; data: { streamName?: string; photos?: WebstreamPhoto[] } }> {
  let partition = DEFAULT_PARTITION
  for (let hop = 0; hop < 3; hop++) {
    const res = await post(`${baseUrl(partition, token)}/webstream`, { streamCtag: null })
    if (res.status === 330 || res.status === 301 || res.status === 302) {
      const body = await res.json().catch(() => null) as { 'X-Apple-MMe-Host'?: string } | null
      const host = res.headers.get('x-apple-mme-host') ?? body?.['X-Apple-MMe-Host']
      const m = host?.match(/^(p\d+)-/)
      if (!m) throw new Error('Shared album redirect without partition host')
      partition = m[1]!
      continue
    }
    if (!res.ok) throw new Error(`Shared album webstream HTTP ${res.status}`)
    return { partition, data: await res.json() as { streamName?: string; photos?: WebstreamPhoto[] } }
  }
  throw new Error('Shared album: too many partition redirects')
}

/** Pick the largest non-thumbnail derivative for display. */
function bestDerivative(p: WebstreamPhoto): { checksum: string; width: number; height: number } | null {
  let best: { checksum: string; width: number; height: number } | null = null
  for (const d of Object.values(p.derivatives ?? {})) {
    if (!d.checksum) continue
    const w = Number(d.width ?? 0)
    const h = Number(d.height ?? 0)
    if (!best || w > best.width) best = { checksum: d.checksum, width: w, height: h }
  }
  return best
}

const cache = new Map<string, { at: number; album: SharedAlbum }>()

export async function fetchSharedAlbum(token: string): Promise<SharedAlbum> {
  const cached = cache.get(token)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.album

  const { partition, data } = await webstream(token)
  const photos = (data.photos ?? []).filter((p) => p.photoGuid)
  const wanted = new Map<string, WebstreamPhoto>()
  const checksums = new Map<string, string>()   // checksum → guid
  for (const p of photos) {
    const best = bestDerivative(p)
    if (!best) continue
    wanted.set(p.photoGuid, p)
    checksums.set(best.checksum, p.photoGuid)
  }

  const assetRes = await post(`${baseUrl(partition, token)}/webasseturls`, { photoGuids: [...wanted.keys()] })
  if (!assetRes.ok) throw new Error(`Shared album webasseturls HTTP ${assetRes.status}`)
  const assets = await assetRes.json() as { items?: Record<string, { url_location?: string; url_path?: string }> }

  const out: SharedAlbumPhoto[] = []
  for (const [checksum, item] of Object.entries(assets.items ?? {})) {
    const guid = checksums.get(checksum)
    if (!guid || !item.url_location || !item.url_path) continue
    const p = wanted.get(guid)!
    const best = bestDerivative(p)!
    const host = item.url_location.startsWith('http') ? item.url_location : `https://${item.url_location}`
    out.push({
      guid,
      url: `${host}${item.url_path}`,
      width: best.width,
      height: best.height,
      caption: p.caption?.trim() || null,
      createdAt: p.dateCreated ?? null,
      isVideo: p.mediaAssetType?.toLowerCase() === 'video',
    })
  }
  // Newest first, videos excluded (the frame shows stills).
  out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  const album: SharedAlbum = { name: data.streamName ?? null, photos: out.filter((p) => !p.isVideo) }
  cache.set(token, { at: Date.now(), album })
  logger.info(`[icloud] shared album ${token.slice(0, 4)}…: ${album.photos.length} photos`)
  return album
}

/** Extract the share token from a pasted icloud.com/sharedalbum link (or raw token). */
export function parseShareToken(input: string): string | null {
  const trimmed = input.trim()
  const hash = trimmed.match(/#([A-Za-z0-9_-]{8,})/)?.[1]
  if (hash) return hash
  return /^[A-Za-z0-9_-]{8,}$/.test(trimmed) ? trimmed : null
}
