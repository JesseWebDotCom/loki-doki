import { proxyImg } from '@/lib/img'

const PREFIX = 'favicon:v1:'
const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface CacheEntry {
  dataUrl: string // '' = confirmed no favicon
  fetchedAt: number
}

// In-memory layer — avoids localStorage reads and deduplicates concurrent fetches
const mem = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

function fromStorage(domain: string): string | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + domain)
    if (raw === null) return undefined
    const entry: CacheEntry = JSON.parse(raw)
    if (Date.now() - entry.fetchedAt > TTL_MS) {
      localStorage.removeItem(PREFIX + domain)
      return undefined
    }
    return entry.dataUrl
  } catch {
    return undefined
  }
}

function toStorage(domain: string, dataUrl: string): void {
  try {
    localStorage.setItem(PREFIX + domain, JSON.stringify({ dataUrl, fetchedAt: Date.now() }))
  } catch {
    // localStorage full — skip persistence, mem cache still works for this session
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Synchronous read — returns the cached value if already in mem, otherwise null.
// Use this to seed initial state and avoid a flash on re-render.
export function getFaviconSync(domain: string): string | null {
  if (!domain) return null
  const v = mem.get(domain)
  return v !== undefined ? v : null
}

// Returns data URL string, '' if confirmed missing, or checks cache first.
// Multiple callers for the same domain share one in-flight fetch.
export function getFavicon(domain: string): Promise<string> {
  if (!domain) return Promise.resolve('')

  const cached = mem.get(domain)
  if (cached !== undefined) return Promise.resolve(cached)

  const stored = fromStorage(domain)
  if (stored !== undefined) {
    mem.set(domain, stored)
    return Promise.resolve(stored)
  }

  const existing = inflight.get(domain)
  if (existing) return existing

  const promise = (async (): Promise<string> => {
    try {
      // Fetch through our same-origin image proxy: DuckDuckGo's icon endpoint sends no
      // CORS header (a direct fetch throws), and proxying also keeps the browser from
      // contacting DDG directly and disk-caches the icon server-side.
      const res = await fetch(proxyImg(`https://icons.duckduckgo.com/ip3/${domain}.ico`), {
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok || res.headers.get('content-length') === '0') {
        mem.set(domain, '')
        toStorage(domain, '')
        return ''
      }
      const blob = await res.blob()
      if (!blob.size) {
        mem.set(domain, '')
        toStorage(domain, '')
        return ''
      }
      const dataUrl = await blobToDataUrl(blob)
      mem.set(domain, dataUrl)
      toStorage(domain, dataUrl)
      return dataUrl
    } catch {
      mem.set(domain, '')
      return ''
    } finally {
      inflight.delete(domain)
    }
  })()

  inflight.set(domain, promise)
  return promise
}
