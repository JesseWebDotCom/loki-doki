// Coding app API. The frontend embeds OpenCode's own web UI directly (see
// CodingPage.tsx + lib/codingServer.ts's per-user auth proxy): project/session
// management, messaging, diffs, and permission approval all happen inside that
// embedded UI, talking straight to its own sidecar through the proxy. This route
// exists only to mint the signed one-time token the iframe needs to authenticate
// into its user-scoped proxy.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getUserWorkspace, mintProxyToken } from '@/lib/codingServer'
import type { AppEnv } from '@/types'

const coding = new Hono<AppEnv>()

// Mints the iframe src for the embedded OpenCode web UI: ensures this user's
// workspace sidecar + dedicated auth-proxy are running, then a one-time signed token
// that lets the proxy hand the browser a same-origin cookie on first load (see
// codingServer.ts for why each user needs their own origin/port rather than a shared
// path prefix). Reuses the request's own hostname so this works identically over
// localhost or a LAN IP, whichever the browser used to reach the app in the first
// place.
coding.get('/ui-url', requireAuth, async (c) => {
  const user = c.get('user')
  try {
    const server = await getUserWorkspace(user.id)
    const token = await mintProxyToken(user.id)
    const hostname = new URL(c.req.url).hostname
    const origin = `http://${hostname}:${server.proxyPort}`
    // `url` is OpenCode's own documented escape hatch (github.com/sst/opencode#5844)
    // for exactly this situation: its client-side code tries to auto-detect its own
    // canonical address for building absolute WebSocket/ticket URLs (the embedded
    // terminal, notably), and that detection breaks for anything but a bare
    // `localhost` origin with no path/port games. Confirmed live: it was resolving
    // to the sidecar's own internal loopback bind address instead of this proxy's
    // origin, and popping a native Basic Auth prompt for it (reachable because the
    // browser runs on the same machine as the server). Passing it explicitly is the
    // documented fix, not a workaround we invented.
    return c.json({ url: `${origin}/?t=${token}&url=${encodeURIComponent(origin)}` })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Coding sidecar unavailable' }, 503)
  }
})

export { coding }
