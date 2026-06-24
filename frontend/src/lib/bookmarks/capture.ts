// Client-side page capture. Our app already runs in a real browser, so instead of a
// server-side headless Chromium we render the target in a hidden, SAME-ORIGIN proxied
// iframe (/api/proxy/:id) — the page's own JavaScript executes in the user's browser — then:
//   • rasterize the rendered document to a PNG thumbnail (html-to-image), and
//   • (for offline articles) serialize the fully-rendered DOM and post it so the server can
//     localize its assets into a faithful offline archive.
//
// Same-origin (via the proxy) is what makes this possible: we can read iframe.contentDocument
// and html-to-image can inline the page's styles/images without canvas tainting. Sites that
// set a strict response CSP (frame-ancestors / script-src) may refuse to embed or run — those
// throw here and the caller falls back to the server's static archive.

import { toBlob } from 'html-to-image'

const RENDER_TIMEOUT_MS = 25_000
const SETTLE_MS = 2_500 // let JS hydrate/paint after the load event
const THUMB_W = 1280
const THUMB_H = 800

export interface CaptureItem {
  id: string
  url: string
  type: 'live' | 'offline'
}

const inFlight = new Set<string>()

// Capture a thumbnail (always) and, for offline items, a faithful archive. Best-effort:
// resolves true on success, false if the page couldn't be captured (CSP/cross-origin/timeout).
export async function captureAndUpload(item: CaptureItem, opts: { archive?: boolean } = {}): Promise<boolean> {
  if (inFlight.has(item.id)) return false
  inFlight.add(item.id)

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText =
    `position:fixed;left:-99999px;top:0;width:${THUMB_W}px;height:1600px;border:0;opacity:0;pointer-events:none;`
  // Allow scripts so the page renders; same-origin so we can read it back.
  iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups')
  iframe.src = `/api/proxy/${item.id}/`

  try {
    document.body.appendChild(iframe)
    await onceLoaded(iframe, RENDER_TIMEOUT_MS)
    await delay(SETTLE_MS)

    const doc = iframe.contentDocument
    if (!doc || !doc.body) throw new Error('capture blocked (no same-origin document)')

    // 1) Thumbnail — clip to a viewport-sized region at the top of the page.
    const blob = await toBlob(doc.documentElement, {
      width: THUMB_W,
      height: THUMB_H,
      pixelRatio: 1,
      backgroundColor: '#ffffff',
      cacheBust: false,
      skipFonts: true, // fonts aren't worth the failure risk for a thumbnail
      style: { transformOrigin: 'top left' },
      filter: (n) => !(n instanceof HTMLScriptElement),
    }).catch(() => null)
    if (blob) await postThumbnail(item.id, blob)

    // 2) Archive — serialize the rendered DOM with URLs de-proxied back to their origins.
    if (opts.archive) {
      const html = serializeRendered(doc, item)
      if (html) await postSnapshot(item.id, html)
    }
    return true
  } catch {
    return false
  } finally {
    iframe.remove()
    inFlight.delete(item.id)
  }
}

// Serialize the rendered document and undo the proxy's URL rewriting so the server sees the
// real resource origins (proxy turned same-origin/absolute-path URLs into /api/proxy/:id/…).
function serializeRendered(doc: Document, item: CaptureItem): string | null {
  let origin: string
  try { origin = new URL(item.url).origin } catch { return null }

  let html = '<!doctype html>\n' + doc.documentElement.outerHTML
  const proxyAbs = `${location.origin}/api/proxy/${item.id}/`
  const proxyRel = `/api/proxy/${item.id}/`
  html = html.split(proxyAbs).join(`${origin}/`).split(proxyRel).join(`${origin}/`)
  // Drop the <base> the proxy injected (would otherwise re-root relative URLs at our origin).
  html = html.replace(/<base\b[^>]*>/gi, '')
  return html
}

function onceLoaded(iframe: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('render timeout')), timeoutMs)
    iframe.addEventListener('load', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function postThumbnail(id: string, blob: Blob): Promise<void> {
  await fetch(`/api/bookmarks/${id}/thumbnail`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'image/png' }, body: blob,
  })
}

async function postSnapshot(id: string, html: string): Promise<void> {
  await fetch(`/api/bookmarks/${id}/snapshot`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html }),
  })
}
