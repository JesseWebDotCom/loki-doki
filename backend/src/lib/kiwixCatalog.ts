// Resolve a ZIM's current dated filename, exact byte size, and Metalink (.meta4) URL from
// the Kiwix OPDS v2 catalog.
//
// This replaces the old approach of scraping the `download.kiwix.org/zim/<dir>/` HTML
// directory listing with a regex — which broke when the bare directory index began
// redirecting to hub.kiwix.org, silently failing to find Wikipedia / Stack Overflow.
//
// The OPDS feed hands us, in one request:
//   • the exact current dated filename (e.g. wikipedia_en_all_mini_2026-06.zim) — no guessing
//   • the exact byte length (the hardcoded catalog sizes drift badly: "mini ~8 GB" is 12.5 GB)
//   • the `.meta4` acquisition URL, which aria2 fans out across every Kiwix mirror at once
//
// Endpoint: https://opds.library.kiwix.org/catalog/v2/entries?q=<term>&lang=<iso639-3>&count=N
// `q` matches human titles/descriptions (NOT the underscore filename — `q=wikipedia_en_all_mini`
// returns zero), so we query a broad token and match the acquisition href against the exact
// kiwixName ourselves.

const OPDS_ENTRIES = 'https://opds.library.kiwix.org/catalog/v2/entries'

// Kiwix filenames embed a 2/3-letter language code (…_en_…, ted_mul_all). The OPDS `lang`
// filter wants ISO 639-3. Map the codes that actually appear in our ZIM catalog; anything
// unmapped just falls back to an unfiltered (broader) query.
const LANG_ISO639_3: Record<string, string> = {
  en: 'eng', mul: 'mul', he: 'heb', de: 'deu', fr: 'fra', es: 'spa',
}

export interface ResolvedZim {
  fileName: string   // wikipedia_en_all_mini_2026-06.zim
  meta4Url: string   // https://lb.download.kiwix.org/zim/wikipedia/<file>.zim.meta4
  zimUrl: string     // same, without the trailing .meta4
  sizeBytes: number  // exact, from the catalog (0 if the feed omitted length)
  zimDate: string | null  // "2026-06"
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// First path segment of the kiwixName is a reliable, tokenizable search term:
//   wikipedia_en_all_mini → "wikipedia"   stackoverflow.com_en_all → "stackoverflow"
//   ted_mul_all → "ted"                    zimgit-post-disaster_en → "zimgit-post-disaster"
function searchToken(kiwixName: string): string {
  return kiwixName.split(/[_.]/)[0] || kiwixName
}

function langFilter(kiwixName: string): string | null {
  const m = kiwixName.match(/_([a-z]{2,3})(?:_|$)/)
  return m ? (LANG_ISO639_3[m[1] ?? ''] ?? null) : null
}

/**
 * Scan an OPDS Atom feed for the open-access acquisition link whose file is
 * `<kiwixName>_YYYY-MM.zim.meta4`, returning the newest dated match. Tag-attribute order
 * varies, so we locate each <link> tag first and read href + length independently.
 */
function pickFromFeed(xml: string, kiwixName: string): ResolvedZim | null {
  const fileRe = new RegExp(`/(${escapeRegExp(kiwixName)}_(\\d{4}-\\d{2})\\.zim)\\.meta4$`)
  let best: ResolvedZim | null = null
  for (const tag of xml.matchAll(/<link\b[^>]*>/g)) {
    const t = tag[0]
    const hrefM = t.match(/href="([^"]+)"/)
    if (!hrefM?.[1]) continue
    const href = hrefM[1].replace(/&amp;/g, '&')
    const fileM = href.match(fileRe)
    if (!fileM?.[1] || !fileM[2]) continue
    const fileName = fileM[1]
    const zimDate = fileM[2]
    const lenM = t.match(/length="(\d+)"/)
    const sizeBytes = lenM ? Number(lenM[1]) : 0
    if (!best || (zimDate > (best.zimDate ?? ''))) {
      best = { fileName, meta4Url: href, zimUrl: href.replace(/\.meta4$/, ''), sizeBytes, zimDate }
    }
  }
  return best
}

/**
 * Resolve a ZIM from the OPDS catalog. Returns null (rather than throwing) on any failure
 * so the caller can fall back to the legacy HTML directory scrape.
 */
export async function resolveZimFromCatalog(
  kiwixName: string,
  signal?: AbortSignal,
): Promise<ResolvedZim | null> {
  const enc = encodeURIComponent
  // Query forms in priority order (each is filtered down to the exact <kiwixName>_DATE file):
  //   1. exact `name` — works for most ZIMs (stackoverflow.com_en_all, ted_mul_all, …)
  //   2. flavour-stripped `name` — Wikipedia's OPDS name is `wikipedia_en_all`, with the
  //      flavour (mini/nopic/maxi) only in the filename, so `name=wikipedia_en_all` lists all
  //      three and pickFromFeed selects the requested one
  //   3. `q` token + optional language — last-resort full-text search
  const token = searchToken(kiwixName)
  const stripped = kiwixName.replace(/_[^_]+$/, '')
  const lang = langFilter(kiwixName)
  const queries = [
    `?name=${enc(kiwixName)}&count=50`,
    ...(stripped !== kiwixName ? [`?name=${enc(stripped)}&count=50`] : []),
    ...(lang ? [`?q=${enc(token)}&lang=${lang}&count=200`] : []),
    `?q=${enc(token)}&count=400`,
  ]

  for (const qs of queries) {
    try {
      const res = await fetch(OPDS_ENTRIES + qs, {
        headers: { 'User-Agent': 'loki-doki/1.0' },
        signal: signal ?? AbortSignal.timeout(30_000),
      })
      if (!res.ok) continue
      const hit = pickFromFeed(await res.text(), kiwixName)
      if (hit) return hit
    } catch { /* try the next query form */ }
  }
  return null
}
