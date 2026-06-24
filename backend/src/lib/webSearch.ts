// Real keyless multi-engine web search. Shared by the briefing source fetchers
// (Patch fallback, "events near {city}"), the `search` tool, and any caller that
// just wants raw web results.
//
// Replaces the old DuckDuckGo Instant-Answer API (api.duckduckgo.com/?format=json),
// which is NOT a web search engine — it only returns Wikipedia/Wikidata entity
// abstracts and is empty for general or current queries ("is X still alive",
// "who won the 2024 world series"). That made online search look broken: every
// general query fell straight through to offline Wikipedia.
//
// Engines, in priority order:
//   0. SearXNG     — local metasearch sidecar (lib/searxng), when installed + running.
//                    Aggregates Google/Brave/Startpage/etc. server-side; gets results from
//                    a home IP where bare scraping is blocked. Leads when up; the keyless
//                    scrapers below are the fallback while it installs / is down / absent.
//   1. Google      — best keyless coverage, via the maintained `google-sr` scraper.
//                    NOTE: from a server IP Google now serves a JS-only shell, so this
//                    often returns nothing — kept because it works on some networks.
//   2. DuckDuckGo  — via the maintained `duck-duck-scrape` lib (DDG's vqd/JSON flow).
//   3. Mojeek      — independent crawler, scrape-friendly from any IP.
//   4. Marginalia  — independent indie index, free keyless JSON API.
//
// Engines run concurrently; each swallows its own errors and returns []. Results are
// merged by priority and deduped by URL, so one slow/blocked engine never sinks a query.

import { search as googleSearch, OrganicResult } from 'google-sr'
import { search as ddgSearch, SafeSearchType } from 'duck-duck-scrape'
import { searxngSearch } from '@/lib/searxng'
import { stripTags, decodeEntities } from '@/lib/htmlText'

export interface WebResult {
  title: string
  snippet: string
  url: string
  engine?: string
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'

// ── URL helpers ────────────────────────────────────────────────────────────────

/** Normalize for dedup: drop protocol, www, trailing slash, fragment. */
function urlKey(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

// ── Engine: SearXNG (local metasearch sidecar) ───────────────────────────────────

async function searxng(query: string, limit: number, timeoutMs: number): Promise<WebResult[]> {
  // Returns [] unless the sidecar is installed and 'ready' (self-gated in searxngSearch),
  // so this is a no-op until SearXNG is set up — webSearch then runs purely on the scrapers.
  const results = await searxngSearch(query, limit, timeoutMs)
  return results.map(r => ({ title: r.title, snippet: r.snippet, url: r.url, engine: 'searxng' }))
}

// ── Engine: Google (via google-sr) ───────────────────────────────────────────────

async function google(query: string, limit: number, timeoutMs: number): Promise<WebResult[]> {
  try {
    // OrganicResult + noPartialResults guarantees title/link are present; `link` is
    // already the real destination (google-sr unwraps Google's redirect for us).
    const results = await googleSearch({
      query,
      parsers: [OrganicResult],
      noPartialResults: true,
      requestConfig: {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      },
    })
    return results
      .filter(r => !r.isAd)
      .slice(0, limit)
      .map(r => ({
        title: stripTags(r.title),
        snippet: stripTags(r.description ?? ''),
        url: r.link,
        engine: 'google',
      }))
  } catch { return [] }
}

// ── Engine: DuckDuckGo (via duck-duck-scrape) ─────────────────────────────────────

async function ddg(query: string, limit: number, timeoutMs: number): Promise<WebResult[]> {
  try {
    // Uses DDG's vqd/JSON flow under the hood — survives where the old POST to
    // html.duckduckgo.com got a 202 "anomaly" bot-block. SafeSearch OFF so adult/edgy
    // queries aren't silently dropped (relevance + content policy are gated upstream).
    const res = await ddgSearch(query, { safeSearch: SafeSearchType.OFF }, { response_timeout: timeoutMs })
    if (res.noResults) return []
    return res.results
      .slice(0, limit)
      // description carries bold tags per the lib's own docs — strip them.
      .map(r => ({ title: stripTags(r.title), snippet: stripTags(r.description), url: r.url, engine: 'duckduckgo' }))
  } catch { return [] }
}

// ── Engine: Mojeek ───────────────────────────────────────────────────────────────

async function mojeek(query: string, timeoutMs: number): Promise<WebResult[]> {
  let res: Response
  try {
    res = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch { return [] }
  if (!res.ok) return []
  const html = await res.text().catch(() => '')
  if (!html) return []

  const out: WebResult[] = []
  // <a class="title" title="URL" href="URL">TITLE</a> ... <p class="s">SNIPPET</p>
  const re = /<a class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?:<p class="s">([\s\S]*?)<\/p>)?(?=<a class="title"|<\/li>|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const url = decodeEntities(m[1])
    const title = stripTags(m[2])
    const snippet = stripTags(m[4] ?? '')
    if (url && title && /^https?:/.test(url)) out.push({ title, snippet, url, engine: 'mojeek' })
  }
  return out
}

// ── Engine: Marginalia ───────────────────────────────────────────────────────────

async function marginalia(query: string, limit: number, timeoutMs: number): Promise<WebResult[]> {
  let res: Response
  try {
    res = await fetch(
      `https://api.marginalia-search.com/public/search/${encodeURIComponent(query)}?count=${limit}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) },
    )
  } catch { return [] }
  if (!res.ok) return []
  let data: { results?: Array<{ url?: string; title?: string; description?: string }> }
  try { data = await res.json() } catch { return [] }
  return (data.results ?? [])
    .filter(r => r.url && r.title)
    .map(r => ({
      title: stripTags(r.title!),
      snippet: stripTags(r.description ?? ''),
      url: r.url!,
      engine: 'marginalia',
    }))
}

// ── Merge ────────────────────────────────────────────────────────────────────────

/**
 * Run a web search across all keyless engines and return up to `limit` deduped
 * results, or [] on total failure (never throws). Engines run concurrently; results
 * are merged in priority order (Google → DuckDuckGo → Mojeek → Marginalia), so the
 * big indexes lead when available and the independent crawlers backfill when those
 * are blocked or thin.
 */
export async function webSearch(query: string, limit = 5, timeoutMs = 6000): Promise<WebResult[]> {
  const q = query.trim()
  if (!q) return []

  const [searx, goog, duck, moj, marg] = await Promise.all([
    searxng(q, Math.max(limit, 5), timeoutMs),
    google(q, Math.max(limit, 5), timeoutMs),
    ddg(q, Math.max(limit, 5), timeoutMs),
    mojeek(q, timeoutMs),
    marginalia(q, Math.max(limit, 5), timeoutMs),
  ])

  const merged: WebResult[] = []
  const seen = new Set<string>()
  for (const list of [searx, goog, duck, moj, marg]) {
    for (const r of list) {
      const key = urlKey(r.url)
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(r)
      if (merged.length >= limit) return merged
    }
  }
  return merged
}
