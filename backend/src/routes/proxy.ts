import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { assertPublicUrl, SsrfError } from '@/lib/ssrfGuard'
import type { AppEnv } from '@/types'

const proxyRouter = new Hono<AppEnv>()

// ── Transparent reverse proxy for bookmarks ───────────────────────────────────
// Proxies requests to the bookmark's target URL, rewriting HTML so all relative
// and absolute paths stay within the proxy iframe (same-origin).

async function handleProxy(c: Parameters<Parameters<typeof proxyRouter.get>[1]>[0], subpath: string) {
  const user  = c.get('user')
  const id    = c.req.param('id')
  const qs    = new URL(c.req.url).search ?? ''

  const bm = await db.select().from(bookmarks)
    .where(eq(bookmarks.id, id))
    .then(r => r[0])

  if (!bm) return c.json({ error: 'Not found' }, 404)

  // Must own it OR it must be a global bookmark
  if (bm.ownerId !== null && bm.ownerId !== user.id) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const targetOrigin = new URL(bm.url).origin

  // No subpath → fetch the exact bookmark URL
  // With subpath → fetch origin + subpath (relative to the target's origin)
  const target = subpath ? `${targetOrigin}/${subpath}${qs}` : `${bm.url}${qs}`

  // SSRF guard: the target is user-controlled (bookmark URL + subpath), and the
  // server sits next to Ollama/ComfyUI/the router admin. Reject internal hosts.
  try {
    await assertPublicUrl(target)
  } catch (err) {
    if (err instanceof SsrfError) return c.json({ error: 'Blocked destination' }, 403)
    throw err
  }

  let upstream: Response
  try {
    const reqHeaders: Record<string, string> = {}
    const accept         = c.req.header('accept')
    const acceptLanguage = c.req.header('accept-language')
    const userAgent      = c.req.header('user-agent')
    if (accept)         reqHeaders['accept']          = accept
    if (acceptLanguage) reqHeaders['accept-language'] = acceptLanguage
    if (userAgent)      reqHeaders['user-agent']      = userAgent

    upstream = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: reqHeaders,
    })
  } catch {
    return c.json({ error: 'Upstream unreachable' }, 502)
  }

  const proxyBase = `/api/proxy/${id}/`

  // ── Redirects ────────────────────────────────────────────────────────────────
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location') ?? '/'
    let proxyLocation: string
    try {
      const locUrl = new URL(location, targetOrigin)
      if (locUrl.origin === targetOrigin) {
        // Same-origin: rewrite to proxy path
        const pathAndQuery = locUrl.pathname.slice(1) + locUrl.search
        proxyLocation = proxyBase + pathAndQuery
      } else {
        proxyLocation = location
      }
    } catch {
      proxyLocation = location
    }
    return c.redirect(proxyLocation, 302)
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'

  // ── HTML responses ────────────────────────────────────────────────────────────
  if (contentType.includes('text/html')) {
    const html = await upstream.text()

    const rewritten = html
      // Inject <base> immediately after <head opening tag
      .replace(/(<head[^>]*>)/i, `$1<base href="${proxyBase}">`)
      // Strip inline CSP meta tags (header stripping doesn't cover these)
      .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '')
      .replace(/<meta[^>]+content-security-policy[^>]+http-equiv[^>]*>/gi, '')
      // Rewrite same-origin absolute URLs in href/src/action
      .replace(
        new RegExp(`((?:href|src|action)=["'])${escapeReg(targetOrigin)}/`, 'g'),
        `$1${proxyBase}`,
      )
      // Rewrite absolute paths (but not protocol-relative //)
      .replace(/((?:href|src|action)=["'])\/(?!\/)/g, `$1${proxyBase}`)
      // Rewrite CSS url() with same-origin absolute
      .replace(
        new RegExp(`url\\(['"]?${escapeReg(targetOrigin)}/`, 'g'),
        `url('${proxyBase}`,
      )
      // Rewrite CSS url() with absolute path
      .replace(/url\(['"]?\//g, `url('${proxyBase}`)

    const headers = new Headers(upstream.headers)
    // Strip headers that block iframing, but only when the site permits it.
    // X-Frame-Options: DENY means the site has explicitly forbidden embedding —
    // pass it through so the browser refuses; SAMEORIGIN is safe to strip
    // because the proxy serves from our origin.
    const xfo = (upstream.headers.get('x-frame-options') ?? '').toUpperCase()
    if (xfo !== 'DENY') headers.delete('x-frame-options')
    // Strip inline CSP meta tags (done above in rewritten HTML) but leave the
    // response-header CSP intact; most CSP directives don't block iframing and
    // stripping them blanket-removes security controls the site deliberately set.
    headers.delete('content-security-policy-report-only')
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.delete('transfer-encoding')

    return new Response(rewritten, { status: upstream.status, headers })
  }

  // ── Non-HTML: pass through, honoring frame/CSP headers ────────────────────────
  const headers = new Headers(upstream.headers)
  // Same rule: only strip SAMEORIGIN, never DENY
  const xfoPassthrough = (upstream.headers.get('x-frame-options') ?? '').toUpperCase()
  if (xfoPassthrough !== 'DENY') headers.delete('x-frame-options')
  headers.delete('content-security-policy-report-only')

  return new Response(upstream.body, { status: upstream.status, headers })
}

// GET /api/proxy/:id  — fetch exact bookmark URL
proxyRouter.get('/:id', requireAuth, async (c) => {
  return handleProxy(c, '')
})

// GET /api/proxy/:id/*  — fetch target origin + subpath
proxyRouter.get('/:id/*', requireAuth, async (c) => {
  const id     = c.req.param('id')
  const prefix = `/api/proxy/${id}/`
  const subpath = c.req.path.startsWith(prefix)
    ? c.req.path.slice(prefix.length)
    : ''
  return handleProxy(c, subpath)
})

function escapeReg(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { proxyRouter as proxy }
