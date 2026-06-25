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
