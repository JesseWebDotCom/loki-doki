// Shared fetch plumbing for retail scrapers: a per-host politeness throttle, a
// plain-fetch → headless-browser ladder (Akamai/PerimeterX-fronted stores 403 or serve
// challenge pages to bare fetches; a real Chromium render usually passes from a
// residential IP), and money/GTIN normalization helpers used by every adapter.

import { fetchHtml, BROWSER_UA } from '@/lib/scrape'
import { renderPage } from '@/lib/bookmarks/render'

// ── per-host throttle ────────────────────────────────────────────────────────────
// Minimum jittered gap between requests to the same store, shared by browse, resolve,
// and the poller so the appliance never looks like a crawler no matter who's asking.

const lastHitAt = new Map<string, number>()
const MIN_GAP_MS = 10_000

async function throttleHost(host: string): Promise<void> {
  const now = Date.now()
  const gap = MIN_GAP_MS + Math.random() * 5_000
  const readyAt = (lastHitAt.get(host) ?? 0) + gap
  // Reserve our slot before sleeping so concurrent callers queue behind each other.
  lastHitAt.set(host, Math.max(now, readyAt))
  if (readyAt > now) await new Promise(r => setTimeout(r, readyAt - now))
}

// ── fetch ladder ─────────────────────────────────────────────────────────────────

export interface LadderOptions {
  /** Adapter-specific marker check — catches 200-with-captcha/challenge responses. */
  isValid: (html: string) => boolean
  /** Skip the plain fetch for stores known to hard-403 it (HD, Lowe's). */
  forceBrowser?: boolean
  /** Fall back to the free Jina reader proxy when direct + render both fail. */
  tryReaderProxy?: boolean
  headers?: Record<string, string>
}

export interface LadderResult {
  html: string
  via: 'fetch' | 'browser' | 'proxy'
}

/** Generic challenge-page tells, checked in addition to the adapter's own marker. */
export function looksBlocked(html: string): boolean {
  if (html.length < 20_000 && /px-captcha|Robot or human|Access Denied|are you a human|Reference #\d/i.test(html)) return true
  return false
}

/** Follows a tracking/affiliate redirect chain (e.g. a deal aggregator's "click" link,
 *  which typically bounces through 2-4 affiliate-network hops before the real retailer
 *  page) and returns the final URL. Uses HEAD first since every hop is just a 30x with
 *  no body to read; some affiliate redirectors reject HEAD, so a GET is the fallback —
 *  its body is left unread (undici doesn't pay to drain it), we only want `res.url`.
 *  Never throws: any failure (timeout, DNS, non-HTTP scheme) returns the original URL,
 *  so callers can always treat this as "best-effort improvement", not a hard dependency. */
export async function followRedirect(url: string, timeoutMs = 8_000): Promise<string> {
  const opts = (method: string): RequestInit => ({
    method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': BROWSER_UA },
  })
  try {
    const res = await fetch(url, opts('HEAD'))
    if (res.url && res.url !== url) return res.url
    if (res.ok || res.status === 405) return res.url || url
  } catch { /* fall through to GET */ }
  try {
    const res = await fetch(url, opts('GET'))
    return res.url || url
  } catch {
    return url
  }
}

export async function fetchWithLadder(url: string, opts: LadderOptions): Promise<LadderResult | null> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  await throttleHost(host)

  if (!opts.forceBrowser) {
    const html = await fetchHtml(url, { timeoutMs: 15_000, retries: 1, headers: opts.headers })
    if (html && !looksBlocked(html) && opts.isValid(html)) return { html, via: 'fetch' }
  }

  // Shop only ever reads `.html` here — skip Reader's screenshot+PDF capture (real latency
  // we don't need) and bound the whole render well under what a user will wait on a product
  // page for, so a slow/stuck site degrades to the next ladder rung instead of hanging.
  const rendered = await renderPage(url, { captureMedia: false, timeoutMs: 15_000 })
  if (rendered && opts.isValid(rendered.html)) return { html: rendered.html, via: 'browser' }

  // Last resort: a free per-call reader proxy (Jina) fetches from its own IP and can get
  // through stores that rate-limit/UA-block our home IP (it does NOT beat datacenter-IP
  // blocklists like Home Depot's Akamai, but helps moderately-protected stores). Opt-in via
  // the caller so we don't add latency where the direct paths already work.
  if (opts.tryReaderProxy) {
    const html = await fetchViaReader(url)
    if (html && opts.isValid(html)) return { html, via: 'proxy' }
  }
  return null
}

/** Fetch a URL's raw HTML through Jina's free Reader (r.jina.ai) — a per-call proxy that
 *  renders from its own IP. Returns null on failure; never throws. */
export async function fetchViaReader(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'X-Return-Format': 'html', Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const html = await res.text()
    // Jina echoes upstream errors as its own 200 with a "Warning: … returned error 4xx" line.
    if (/Target URL returned error \d/i.test(html.slice(0, 400))) return null
    return html.length > 500 ? html : null
  } catch {
    return null
  }
}

// ── normalization helpers ────────────────────────────────────────────────────────

/** "$1,299.00" / "1299" / "USD 12.99" → integer cents, or null when unparseable. */
export function parseMoney(s: string | number | null | undefined): number | null {
  if (s == null) return null
  if (typeof s === 'number') return Number.isFinite(s) ? Math.round(s * 100) : null
  const m = s.replace(/[, ]/g, '').match(/(\d+)(?:\.(\d{1,2}))?/)
  if (!m) return null
  const dollars = Number(m[1])
  const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0
  if (!Number.isFinite(dollars)) return null
  return dollars * 100 + cents
}

/** Normalize UPC-A/EAN/GTIN variants to GTIN-13 (leading-zero pad); null when invalid. */
export function normalizeGtin(s: string | null | undefined): string | null {
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 14) return null
  if (digits.length === 14 && digits.startsWith('0')) return digits.slice(1)
  if (digits.length > 13) return null
  return digits.padStart(13, '0')
}

/** Decode the HTML entities that show up inside product titles and coupon text —
 *  named and numeric (decimal + hex), which retail/coupon pages both use. */
export function decodeTitle(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pull a plain description + star rating off a schema.org Product node — shared by every
 *  JSON-LD-based adapter (generic, Home Depot/Lowe's/Apple/Costco/BJ's) so the "does this
 *  store expose a rating" logic lives in one place. Both fields are best-effort; null when
 *  the node doesn't carry them — never fabricated. */
export function extractJsonLdRatingAndDescription(node: Record<string, unknown>): {
  description: string | null
  rating: { value: number; count: number } | null
} {
  const rawDesc = node.description
  const description = typeof rawDesc === 'string' && rawDesc.trim()
    ? decodeTitle(rawDesc).slice(0, 500)
    : null

  let rating: { value: number; count: number } | null = null
  const agg = node.aggregateRating
  if (agg && typeof agg === 'object') {
    const a = agg as Record<string, unknown>
    const value = Number(a.ratingValue)
    const count = Number(a.reviewCount ?? a.ratingCount ?? 0)
    if (Number.isFinite(value) && value > 0 && value <= 5) {
      rating = { value, count: Number.isFinite(count) ? count : 0 }
    }
  }
  return { description, rating }
}
