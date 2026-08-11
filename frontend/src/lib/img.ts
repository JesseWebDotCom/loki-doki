import type { ImgHTMLAttributes } from 'react'

// App-wide image proxy helper. Route any remote image the UI renders through the backend's
// /api/img read-through cache instead of letting the browser hit the upstream host. This
// keeps the user's IP/Referer off third-party CDNs (privacy), survives signed/hotlink-
// protected sources (e.g. Guardian's i.guim.co.uk), and caches bytes on disk.
//
// Pass-through (returned unchanged) for anything that's already local or inlined: relative
// paths, data:/blob: URIs, and same-origin URLs. Use this for arbitrary external imagery
// (news/article thumbnails, recipe/show cards, remote avatars). YouTube and Shows/Movies
// have their own specialised proxies (ytImageProxy / mediaImg) — keep using those there.

/** Optional width hint for card/grid renders: the proxy serves a bucketed webp
 *  downscale (240/480/960) instead of the original bytes. Pass the DEVICE-pixel
 *  width you render at (CSS px × ~2); omit for heroes, backdrops, and lightboxes. */
export function proxyImg(url: string | null | undefined, w?: number): string {
  if (!url) return ''
  // Already local/inlined — nothing to proxy.
  if (/^(\/(?!\/)|data:|blob:)/.test(url)) return url
  try {
    const u = new URL(url, window.location.origin)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url
    if (u.origin === window.location.origin) return url // same-origin asset
    return `/api/img?u=${encodeURIComponent(u.toString())}${w ? `&w=${Math.round(w)}` : ''}`
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
export function proxyImgAuto(url: string | null | undefined, w?: number): string {
  if (!url) return ''
  try {
    const u = new URL(url, window.location.origin)
    if ((u.protocol === 'https:' || u.protocol === 'http:') && YT_IMG_HOSTS.test(u.hostname)) {
      // Video thumbnails are already size-tiered upstream (mqdefault/hqdefault), so `w`
      // rarely matters for them. Channel avatars are the opposite: YouTube hands them over
      // at up to 900px square for a 20px circle, so the proxy uses `w` to ask Google's CDN
      // for the right `=sNNN` size (falling back to its own downscale). Pass the DEVICE-
      // pixel width, same contract as proxyImg.
      return `/api/youtube/img?u=${encodeURIComponent(u.toString())}${w ? `&w=${Math.round(w)}` : ''}`
    }
  } catch { /* fall through to the generic proxy's own handling */ }
  return proxyImg(url, w)
}

/** Device-pixel width a card-sized creator avatar (size-4 through size-8, at up to 3x)
 *  asks for. Anything bigger - channel headers, creator rails - passes AVATAR_W_LARGE. */
export const AVATAR_W = 96
/** Device-pixel width for header/rail avatars (size-14 through size-24 at up to 3x). */
export const AVATAR_W_LARGE = 288

/** The exact URL CreatorAvatar renders. Preloaders MUST build their URLs through this,
 *  with the same width, or they warm a URL no card ever requests. */
export function avatarImgUrl(url: string | null | undefined, width: number = AVATAR_W): string {
  return proxyImgAuto(url, width)
}

/** Loading attributes for a card image. `eager` is for the first screenful of a surface
 *  only: those load immediately at high priority so the page paints with real art. Every
 *  card below stays lazy and is warmed ahead of the scroll instead
 *  (lib/prefetch/useScrollAheadImages), which keeps the browser's handful of connections
 *  to the hub pointed at what the user is actually looking at.
 *
 *  `fetchpriority` is spelled lowercase and cast: React 18 forwards unknown all-lowercase
 *  attributes to the DOM untouched, so this behaves the same before and after React 19
 *  learned the camelCase prop. */
export function imgLoad(eager?: boolean): ImgHTMLAttributes<HTMLImageElement> {
  return (eager
    ? { loading: 'eager', fetchpriority: 'high' }
    : { loading: 'lazy' }) as ImgHTMLAttributes<HTMLImageElement>
}
