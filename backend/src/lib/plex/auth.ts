// plex.tv PIN authentication + server discovery, so an admin can link Plex by approving a
// short code on plex.tv instead of hand-pasting an X-Plex-Token, and pick their server from
// the account's resources instead of typing an IP:port.

const PLEX_TV = 'https://plex.tv/api/v2'
const PRODUCT = 'Media Companion'
const TIMEOUT_MS = 8000

function headers(clientId: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': '1.0',
    'X-Plex-Client-Identifier': clientId,
  }
}

export interface PlexPin {
  id: number
  code: string
  clientId: string
  linkUrl: string
}

/** Create a PIN the user approves at plex.tv/link (or the deep auth URL). NOTE: no `strong=true`
 *  — a strong PIN returns a long code that only works via the auth URL, not the 4-character
 *  manual entry at plex.tv/link, which we offer in the UI. */
export async function createPlexPin(clientId: string): Promise<PlexPin | null> {
  try {
    const res = await fetch(`${PLEX_TV}/pins`, {
      method: 'POST',
      headers: headers(clientId),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: number; code?: string }
    if (!data.id || !data.code) return null
    // Manual-entry page: the user types the 4-character `code` here. (The app.plex.tv/auth
    // deep-link is NOT used — it needs a strong PIN, which can't be entered manually.)
    const linkUrl = 'https://plex.tv/link'
    return { id: data.id, code: data.code, clientId, linkUrl }
  } catch {
    return null
  }
}

/** Poll a PIN; returns the auth token once the user approves it, else null. */
export async function checkPlexPin(id: number, clientId: string): Promise<string | null> {
  try {
    const res = await fetch(`${PLEX_TV}/pins/${id}`, { headers: headers(clientId), signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const data = (await res.json()) as { authToken?: string | null }
    return data.authToken ?? null
  } catch {
    return null
  }
}

export interface PlexServer {
  name: string
  uri: string
  local: boolean
}

/** List the Plex Media Servers reachable by this account, best (local) connection first. */
export async function discoverPlexServers(token: string, clientId: string): Promise<PlexServer[]> {
  try {
    const res = await fetch(`${PLEX_TV}/resources?includeHttps=1&includeRelay=1`, {
      headers: { ...headers(clientId), 'X-Plex-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return []
    const devices = (await res.json()) as Array<{
      name?: string
      provides?: string
      connections?: Array<{ uri?: string; local?: boolean; relay?: boolean }>
    }>
    const servers: PlexServer[] = []
    for (const d of devices) {
      if (!d.provides?.split(',').includes('server')) continue
      const conns = (d.connections ?? []).filter((c) => c.uri)
      // Prefer a non-relay local connection, then any direct, then relay.
      const sorted = conns.sort((a, b) => Number(!!b.local) - Number(!!a.local) || Number(!!a.relay) - Number(!!b.relay))
      const pick = sorted[0]
      if (pick?.uri) servers.push({ name: d.name ?? 'Plex Server', uri: pick.uri, local: !!pick.local })
    }
    return servers
  } catch {
    return []
  }
}
