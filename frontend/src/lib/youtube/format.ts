// Formatting helpers for the YouTube app (ported from the old YoutubePage).

/** Relative age from a unix-ms timestamp, e.g. "3d ago", "2mo ago". */
export function fmtAge(ms: number | null | undefined): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const d = Math.floor(diff / 86_400_000)
  if (d <= 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d}d ago`
  if (d < 30) return `${Math.floor(d / 7)}w ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

/** Human file size, e.g. "1.4 GB" / "320 MB". */
export function fmtBytes(n: number | null | undefined): string {
  if (!n) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

/** Duration "h:mm:ss" / "m:ss". */
export function fmtDur(s: number | null | undefined): string {
  if (!s || s <= 0) return ''
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

/** Clock for scrubbers — always m:ss (or h:mm:ss past an hour). */
export function fmtClock(s: number): string {
  return fmtDur(Math.max(0, Math.floor(s))) || '0:00'
}

/** Resolution label for a video height (2160 → "4K", else "<h>p"). */
export function resLabel(h: number): string {
  return h >= 2160 ? '4K' : `${h}p`
}

/** Badge text for a saved item — quality only. e.g. "4K" / "1080p" / "Audio". */
export function qualityBadge(kind: 'audio' | 'video', maxHeight: number | null | undefined): string {
  return kind === 'audio' ? 'Audio' : maxHeight ? resLabel(maxHeight) : 'Video'
}

/** Compact count, e.g. 1_200_000 → "1.2M". */
export function fmtCount(n: number | null | undefined): string {
  if (n == null) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

/** Normalize a raw view count into a compact "1.2M views" label. The backend hands us
 *  YouTube's own text ("1,234,567 views", "1.2M views"), a plain integer string ("1234567",
 *  from the watch-page player), or a number, all collapse to the same compact form. Live
 *  "watching" counts pass through untouched; returns '' when there's nothing to show. */
export function fmtViews(raw: string | number | null | undefined): string {
  if (raw == null) return ''
  if (typeof raw === 'number') return raw > 0 ? `${fmtCount(raw)} views` : ''
  const s = raw.trim()
  if (!s) return ''
  if (/watching/i.test(s)) return s                         // live stream: "1.2K watching"
  if (/^no\s+views/i.test(s)) return 'No views'
  const compact = s.match(/([\d.,]+)\s*([KMB])\b/i)         // already compact: "1.2M views"
  if (compact) return `${compact[1]}${compact[2].toUpperCase()} views`
  const n = Number(s.replace(/[^\d]/g, ''))                 // grouped or plain digits
  return Number.isFinite(n) && n > 0 ? `${fmtCount(n)} views` : ''
}

/** YouTube thumbnail URL for a videoId at a given quality. */
export function thumbUrl(videoId: string, q: 'mq' | 'hq' | 'sd' | 'maxres' = 'mq'): string {
  const name = q === 'mq' ? 'mqdefault' : q === 'hq' ? 'hqdefault' : q === 'sd' ? 'sddefault' : 'maxresdefault'
  return `https://i.ytimg.com/vi/${videoId}/${name}.jpg`
}
