// GProTab.net client — search for downloadable Guitar Pro tab FILES (as opposed to the
// view-online links tab-search gets from Ultimate Guitar/Songsterr, whose actual files are
// paywalled or not offered). GProTab is a free GP-file sharing site: `/en/search?q=` returns
// result blocks pairing an artist link (class="tab-band") with a song link (class="tab-name"),
// and appending `?download` to any song URL serves the raw .gp3/.gp4/.gp5 file with a
// Content-Disposition filename. Both verified against the live site; parsing is regex over
// those two stable class names, same approach as the other scrape-based lookups here.

import { stripTags, decodeEntities } from '@/lib/htmlText'

export interface GProTabResult {
  artist: string
  title: string
  /** Absolute song-page URL — pass to downloadGProTabFile / open in a browser. */
  url: string
}

const BASE = 'https://gprotab.net'
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'

export function isGProTabSongUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.hostname !== 'gprotab.net' && u.hostname !== 'www.gprotab.net') return false
    // Song pages are /en/tabs/<artist>/<song>; artist index pages have only one segment.
    return /^\/[a-z]{2}\/tabs\/[^/]+\/[^/]+$/.test(u.pathname)
  } catch { return false }
}

export async function searchGProTab(query: string, limit = 6): Promise<GProTabResult[]> {
  let html: string
  try {
    const res = await fetch(`${BASE}/en/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    html = await res.text()
  } catch { return [] }

  const out: GProTabResult[] = []
  const seen = new Set<string>()
  const re = /class="tab-band">([^<]+)<\/a>\s*<a href="(\/[a-z]{2}\/tabs\/[^"]+)" class="tab-name">([^<]+)</g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < limit) {
    const url = `${BASE}${decodeEntities(m[2])}`
    if (seen.has(url) || !isGProTabSongUrl(url)) continue
    seen.add(url)
    out.push({ artist: stripTags(decodeEntities(m[1])).trim(), title: stripTags(decodeEntities(m[3])).trim(), url })
  }
  return out
}

/** Download the raw Guitar Pro file behind a GProTab song page. Returns the bytes plus the
 *  server-supplied filename (carries the real extension — .gp3/.gp4/.gp5 vary per upload). */
export async function downloadGProTabFile(songUrl: string, maxBytes: number): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (!isGProTabSongUrl(songUrl)) return null
  let res: Response
  try {
    res = await fetch(`${songUrl}?download`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    })
  } catch { return null }
  if (!res.ok) return null
  const disposition = res.headers.get('content-disposition') ?? ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? ''
  if (!filename) return null
  const buf = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
  if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null
  return { bytes: buf, filename }
}
