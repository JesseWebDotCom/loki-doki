// Reusable scraping primitives shared by any tool that needs to fetch and parse a
// web page (property lookup, people lookup, and whatever comes next). Nothing here is
// specific to a single site — site-specific logic lives in its own lib and composes
// these helpers. Mirrors the error-swallowing, browser-headers, hard-timeout style of
// lib/webSearch.ts so behaviour is consistent across every scraper in the app.
//
//   fetchHtml(url, opts)     — GET (or POST) a page, return decoded HTML or null on any failure.
//   extractJsonLd(html)      — pull every <script type="application/ld+json"> block, flattening @graph.
//   parseLabelValueTable(html) — turn two-cell <tr> rows into a label→value map (assessor/spec tables).

import { stripTags } from '@/lib/htmlText'
import { assertPublicUrl } from '@/lib/ssrfGuard'

// A realistic desktop-browser UA. We can't impersonate a full TLS fingerprint the way
// curl_cffi does, so some Cloudflare-fronted sites may still 403 from certain IPs — every
// caller must therefore degrade gracefully (null / empty), never assume success.
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export interface FetchHtmlOptions {
  method?: 'GET' | 'POST'
  /** Form body for POST (urlencoded) or raw string. */
  body?: string | Record<string, string>
  headers?: Record<string, string>
  timeoutMs?: number
  /** Number of extra attempts on network error / 5xx (default 1 retry). */
  retries?: number
}

/**
 * Fetch a page with browser-like headers and a hard timeout. Returns the decoded HTML
 * body, or null on any non-2xx status, network error, or timeout. Never throws — callers
 * branch on null. Bun's fetch transparently decompresses gzip/deflate/br.
 */
export async function fetchHtml(url: string, opts: FetchHtmlOptions = {}): Promise<string | null> {
  const { method = 'GET', timeoutMs = 12_000, retries = 1 } = opts
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...opts.headers,
  }
  let body: string | undefined
  if (opts.body != null) {
    if (typeof opts.body === 'string') body = opts.body
    else {
      body = new URLSearchParams(opts.body).toString()
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Follow redirects by hand, re-validating each hop against the SSRF guard so a
      // user-influenced URL (or a redirector) can't reach localhost / the metadata endpoint /
      // a LAN service. The method/body apply only to the first hop; 3xx follow as GET, which
      // matches the sites this scrapes (none 307/308-redirect a form POST to internal).
      let current = url
      let res: Response
      for (let hop = 0; ; hop++) {
        await assertPublicUrl(current)
        res = await fetch(current, {
          method: hop === 0 ? method : 'GET',
          headers,
          body: hop === 0 ? body : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (res.status >= 300 && res.status < 400 && res.headers.has('location') && hop < 6) {
          res.body?.cancel().catch(() => {})
          current = new URL(res.headers.get('location')!, current).toString()
          continue
        }
        break
      }
      if (!res.ok) {
        // Retry transient 5xx; a 4xx (block / not found) won't change on retry.
        if (res.status >= 500 && attempt < retries) continue
        return null
      }
      return await res.text()
    } catch {
      if (attempt < retries) continue
      return null
    }
  }
  return null
}

/**
 * Extract every JSON-LD payload embedded in <script type="application/ld+json"> tags and
 * return a flat list of the structured nodes. Objects carrying an "@graph" array are
 * expanded into their member nodes; bare objects pass through; unparseable blocks are
 * skipped. Many sites (ThatsThem, recipe sites, articles) embed their structured data
 * exactly this way, so this is reusable well beyond people lookup.
 */
export function extractJsonLd(html: string | null | undefined): Record<string, unknown>[] {
  if (!html) return []
  const out: Record<string, unknown>[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    let parsed: unknown
    try {
      parsed = JSON.parse(m[1]!.trim())
    } catch {
      continue
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed]
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const obj = block as Record<string, unknown>
      const graph = obj['@graph']
      if (Array.isArray(graph)) {
        for (const node of graph) {
          if (node && typeof node === 'object') out.push(node as Record<string, unknown>)
        }
      } else {
        out.push(obj)
      }
    }
  }
  return out
}

/**
 * Parse two-column tables — the classic "Label: Value" rows used by government assessor
 * and spec pages (e.g. VGSI parcel cards). Returns a map keyed by the lowercased,
 * colon-stripped label; the first occurrence of a label wins. Rows whose label is empty
 * or absurdly long (>60 chars — almost certainly not a field label) are ignored.
 */
export function parseLabelValueTable(html: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!html) return out
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
  let row: RegExpExecArray | null
  while ((row = rowRe.exec(html))) {
    const cells: string[] = []
    let cell: RegExpExecArray | null
    cellRe.lastIndex = 0
    while ((cell = cellRe.exec(row[1]!))) cells.push(stripTags(cell[1]))
    if (cells.length < 2) continue
    const label = cells[0]!.replace(/:\s*$/, '').trim().toLowerCase()
    const value = cells[1]!.trim()
    if (!label || label.length > 60 || !value) continue
    if (!out.has(label)) out.set(label, value)
  }
  return out
}
