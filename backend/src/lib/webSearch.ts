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
// Tiered: SearXNG runs first and alone (it already fans out across ~20 upstreams);
// the direct scrapers only fire when SearXNG is absent, down, or thin, running
// concurrently with each other. Each engine swallows its own errors and returns [].
// Results are merged by priority and deduped by URL.

import { search as googleSearch, OrganicResult } from 'google-sr'
import { search as ddgSearch, SafeSearchType } from 'duck-duck-scrape'
import { searxngSearch } from '@/lib/searxng'
import { stripTags, decodeEntities } from '@/lib/htmlText'
import { logger } from '@/lib/logger'

export interface WebResult {
  title: string
  snippet: string
  url: string
  engine?: string
  /** Opportunistic thumbnail (SearXNG-only, when the underlying engine attaches
   *  one to a general-category result). Absent for most results. */
  thumbnail?: string
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

async function searxng(query: string, limit: number, timeoutMs: number, safesearch: 0 | 1 | 2, pageno = 1): Promise<WebResult[]> {
  // Returns [] unless the sidecar is installed and 'ready' (self-gated in searxngSearch),
  // so this is a no-op until SearXNG is set up — webSearch then runs purely on the scrapers.
  const results = await searxngSearch(query, limit, timeoutMs, safesearch, pageno)
  return results.map(r => ({ title: r.title, snippet: r.snippet, url: r.url, engine: 'searxng', thumbnail: r.thumbnail }))
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

const DDG_SAFE_SEARCH: Record<0 | 1 | 2, SafeSearchType> = {
  0: SafeSearchType.OFF,
  1: SafeSearchType.MODERATE,
  2: SafeSearchType.STRICT,
}

async function ddg(query: string, limit: number, timeoutMs: number, safesearch: 0 | 1 | 2): Promise<WebResult[]> {
  try {
    // Uses DDG's vqd/JSON flow under the hood — survives where the old POST to
    // html.duckduckgo.com got a 202 "anomaly" bot-block. SafeSearch defaults to OFF so
    // adult/edgy queries aren't silently dropped for open-tier profiles (relevance and
    // content policy are gated upstream); kid/teen tiers pass a stricter level through.
    const res = await ddgSearch(query, { safeSearch: DDG_SAFE_SEARCH[safesearch] }, { response_timeout: timeoutMs })
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

// Merge lists in priority order, deduped by URL. No early cap: the merged list is
// cached below and served to callers with different limits, so trimming happens
// per-caller.
function mergeLists(lists: WebResult[][]): WebResult[] {
  const merged: WebResult[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const r of list) {
      const key = urlKey(r.url)
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(r)
    }
  }
  return merged
}

async function runEngines(q: string, limit: number, timeoutMs: number, safesearch: 0 | 1 | 2, page: number): Promise<WebResult[]> {
  const perEngine = Math.max(limit, 10)

  // Tier 1: SearXNG alone. It already fans out across ~20 upstream engines with
  // proper per-engine adapters, so when it delivers there's no reason to ALSO hit
  // Google/DuckDuckGo/Mojeek/Marginalia directly — the old always-parallel design
  // doubled our upstream footprint on every query and fed the burst-throttling the
  // cache below exists to prevent. Returns [] instantly when the sidecar isn't
  // ready, so a missing/booting SearXNG costs tier 2 nothing.
  const sx = await searxng(q, perEngine, timeoutMs, safesearch, page)
  // Deep pages are SearXNG-only: the direct scrapers can't paginate.
  if (page > 1 || sx.length >= Math.min(limit, 5)) return mergeLists([sx])

  // Tier 2: SearXNG absent, down, or thin — fall back to the direct keyless
  // scrapers (concurrently), merging whatever SearXNG did return ahead of them.
  // DuckDuckGo is the one fallback with a safe-search knob, so it's the only one
  // kid/teen profiles are allowed to reach.
  const lists = await Promise.all([
    safesearch > 0 ? Promise.resolve([]) : google(q, perEngine, timeoutMs),
    ddg(q, perEngine, timeoutMs, safesearch),
    safesearch > 0 ? Promise.resolve([]) : mojeek(q, timeoutMs),
    safesearch > 0 ? Promise.resolve([]) : marginalia(q, perEngine, timeoutMs),
  ])
  const merged = mergeLists([sx, ...lists])
  if (merged.length === 0) {
    // Every engine came up empty — log the per-engine breakdown so "no results"
    // is diagnosable from data/logs instead of a silent mystery.
    const [g, d, m, ma] = lists
    logger.warn(
      `[websearch] no results for "${q}" — searxng:${sx.length} google:${g!.length} ddg:${d!.length} mojeek:${m!.length} marginalia:${ma!.length} (safesearch=${safesearch})`,
    )
  }
  return merged
}

// ── In-flight dedupe + short cache ───────────────────────────────────────────────
// One user action triggers several IDENTICAL searches within seconds: the Spotlight
// typeahead, then the /search page, then the AI Overview grounding the same query.
// Upstream engines throttle/captcha a home IP that repeats a query in a tight burst,
// and SearXNG suspends engines that error — which manifested as "images load but web
// results are empty" on exactly the popular queries that fan out widest. Sharing one
// in-flight fan-out per (query, safesearch) and caching the merged list for a few
// minutes collapses a whole search-page visit into a single upstream hit.
const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; results: WebResult[] }>()
const inflight = new Map<string, Promise<WebResult[]>>()

/**
 * Run a web search across all keyless engines and return up to `limit` deduped
 * results, or [] on total failure (never throws). Engines run concurrently; results
 * are merged in priority order (SearXNG → Google → DuckDuckGo → Mojeek → Marginalia),
 * so the big indexes lead when available and the independent crawlers backfill when
 * those are blocked or thin. Identical concurrent/recent queries share one fan-out
 * (see cache note above).
 *
 * `safesearch` (0=off, 1=moderate, 2=strict) is passed to the engines that support
 * it (SearXNG, DuckDuckGo). Google/Mojeek/Marginalia have no safe-search knob, so for
 * kid/teen profiles (safesearch > 0) they're skipped entirely rather than mixing in
 * unfiltered results — mirrors `restrictedMode` gating YouTube in policyTier.ts.
 */
export async function webSearch(query: string, limit = 5, timeoutMs = 6000, safesearch: 0 | 1 | 2 = 0, page = 1): Promise<WebResult[]> {
  const q = query.trim()
  if (!q) return []
  const key = `${safesearch}|${page}|${q.toLowerCase()}`

  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.results.slice(0, limit)

  let flight = inflight.get(key)
  if (!flight) {
    flight = runEngines(q, limit, timeoutMs, safesearch, page)
      .then((results) => {
        // Only cache success — an empty merge usually means throttled/offline
        // engines, and pinning that for 5 minutes would turn a transient blip
        // into "search is broken until you wait it out".
        if (results.length > 0) {
          cache.set(key, { at: Date.now(), results })
          if (cache.size > 200) {
            const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
            if (oldest) cache.delete(oldest[0])
          }
        }
        return results
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, flight)
  }
  return (await flight).slice(0, limit)
}
