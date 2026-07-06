// Detect what kind of save a captured URL should offer (used by the /save dispatcher).

export type SaveKind =
  | { type: 'youtube'; videoId: string }
  | { type: 'video'; source: 'reddit' | 'tiktok' | 'vimeo'; videoId: string }
  | { type: 'link' }

const isYtId = (s: string | null | undefined): s is string => !!s && /^[\w-]{11}$/.test(s)

export function detectSaveTarget(rawUrl: string): SaveKind {
  let url: URL
  try { url = new URL(rawUrl) } catch { return { type: 'link' } }
  const host = url.hostname.replace(/^www\.|^m\.|^old\./, '')
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    if (isYtId(id)) return { type: 'youtube', videoId: id }
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v')
    if (isYtId(v)) return { type: 'youtube', videoId: v }
    const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)
    if (m && isYtId(m[1])) return { type: 'youtube', videoId: m[1] }
  }
  // Videos hub sources (kept in sync with the backend provider registry's matchUrl).
  if (host === 'reddit.com' && parts[0] === 'r' && parts[2] === 'comments' && parts[3] && /^[a-z0-9]{4,10}$/i.test(parts[3])) {
    return { type: 'video', source: 'reddit', videoId: parts[3] }
  }
  if (host === 'redd.it' && parts[0] && /^[a-z0-9]{4,10}$/i.test(parts[0])) {
    return { type: 'video', source: 'reddit', videoId: parts[0] }
  }
  if (host === 'tiktok.com' && parts[0]?.startsWith('@') && parts[1] === 'video' && parts[2] && /^\d{15,21}$/.test(parts[2])) {
    return { type: 'video', source: 'tiktok', videoId: parts[2] }
  }
  if (host === 'vimeo.com' && parts[0] && /^\d{6,12}$/.test(parts[0])) {
    return { type: 'video', source: 'vimeo', videoId: parts[0] }
  }
  return { type: 'link' }
}
