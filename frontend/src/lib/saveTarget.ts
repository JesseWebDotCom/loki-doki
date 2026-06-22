// Detect what kind of save a captured URL should offer (used by the /save dispatcher).

export type SaveKind =
  | { type: 'youtube'; videoId: string }
  | { type: 'link' }

const isYtId = (s: string | null | undefined): s is string => !!s && /^[\w-]{11}$/.test(s)

export function detectSaveTarget(rawUrl: string): SaveKind {
  let url: URL
  try { url = new URL(rawUrl) } catch { return { type: 'link' } }
  const host = url.hostname.replace(/^www\./, '')

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    if (isYtId(id)) return { type: 'youtube', videoId: id }
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v')
    if (isYtId(v)) return { type: 'youtube', videoId: v }
    const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)
    if (m && isYtId(m[1])) return { type: 'youtube', videoId: m[1] }
  }
  return { type: 'link' }
}
