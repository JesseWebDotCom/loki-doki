// Best-effort image warming: kick off the browser's image fetch+decode for a handful of
// above-the-fold thumbnails so they're already in the HTTP cache when the page renders.
// Idempotent — the browser dedupes by URL, and we also track what we've already kicked off.

const seen = new Set<string>()

export function preloadImages(urls: (string | null | undefined)[], max = 12): void {
  let n = 0
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    if (n >= max) break
    seen.add(url)
    n++
    const img = new Image()
    img.decoding = 'async'
    img.src = url
  }
}
