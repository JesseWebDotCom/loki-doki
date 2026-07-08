// App-wide image proxy helper. Route any remote image the UI renders through the backend's
// /api/img read-through cache instead of letting the browser hit the upstream host. This
// keeps the user's IP/Referer off third-party CDNs (privacy), survives signed/hotlink-
// protected sources (e.g. Guardian's i.guim.co.uk), and caches bytes on disk.
//
// Pass-through (returned unchanged) for anything that's already local or inlined: relative
// paths, data:/blob: URIs, and same-origin URLs. Use this for arbitrary external imagery
// (news/article thumbnails, recipe/show cards, remote avatars). YouTube and Shows/Movies
// have their own specialised proxies (ytImageProxy / mediaImg) — keep using those there.

export function proxyImg(url: string | null | undefined): string {
  if (!url) return ''
  // Already local/inlined — nothing to proxy.
  if (/^(\/(?!\/)|data:|blob:)/.test(url)) return url
  try {
    const u = new URL(url, window.location.origin)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url
    if (u.origin === window.location.origin) return url // same-origin asset
    return `/api/img?u=${encodeURIComponent(u.toString())}`
  } catch {
    return url
  }
}

// Mirrors the host allowlist of /api/youtube/img (backend routes/youtube.ts) — the yt proxy
// rejects anything off Google's CDNs, so routing is fully determined by the URL's host.
const YT_IMG_HOSTS = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|youtube\.com)$/i

/** Source-aware image proxy: Google-CDN images go through /api/youtube/img (YouTube's own
 *  read-through cache, which only allows Google hosts), everything else through /api/img.
 *  Lets shared components (avatars, cards) render images from any source without callers
 *  plumbing a proxy choice around. */
export function proxyImgAuto(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url, window.location.origin)
    if ((u.protocol === 'https:' || u.protocol === 'http:') && YT_IMG_HOSTS.test(u.hostname)) {
      return `/api/youtube/img?u=${encodeURIComponent(u.toString())}`
    }
  } catch { /* fall through to the generic proxy's own handling */ }
  return proxyImg(url)
}
