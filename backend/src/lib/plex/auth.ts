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

export interface PlexAccountInfo {
  id: string
  uuid: string | null
  username: string | null
}

/** Resolve the plex.tv account identity behind a token — needed as the `invited_id` when
 *  sharing a library section to a specific user's account via the shared_servers API.
 *  NOT verified against a live server: `/api/v2/user`'s exact response shape is documented
 *  community knowledge (python-plexapi's MyPlexAccount), not something this codebase has
 *  called before — confirm `id` is the right field once tested against a real account. */
export async function getPlexAccountInfo(token: string): Promise<PlexAccountInfo | null> {
  try {
    const res = await fetch(`${PLEX_TV}/user`, {
      headers: { ...headers('media-companion-server'), 'X-Plex-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: number | string; uuid?: string; username?: string }
    if (data.id == null) return null
    return { id: String(data.id), uuid: data.uuid ?? null, username: data.username ?? null }
  } catch {
    return null
  }
}

export interface PlexKnownAccount {
  id: string
  /** Display name (title falls back to username). */
  name: string
  username: string | null
  email: string | null
  /** True for the server owner's own account. */
  owner: boolean
  /** True for a managed (PIN-only, no email) Plex Home user. */
  restricted: boolean
}

/** Every Plex account the ADMIN token can see: the owner themself, plex.tv friends, and
 *  Plex Home users. This is what lets an admin map app users → Plex accounts without each
 *  person signing in: sharing a library section only needs the invited account's id, never
 *  their token. Both endpoints are best-effort — one failing just yields fewer options.
 *  (Same documented-community-knowledge caveat as getPlexAccountInfo: shapes match
 *  python-plexapi's MyPlexAccount/friends/home models, verify once against real data.) */
export async function listPlexServerAccounts(token: string): Promise<PlexKnownAccount[]> {
  const h = { ...headers('media-companion-server'), 'X-Plex-Token': token }
  const byId = new Map<string, PlexKnownAccount>()

  const owner = await getPlexAccountInfo(token)
  if (owner) byId.set(owner.id, { id: owner.id, name: owner.username ?? 'Owner', username: owner.username, email: null, owner: true, restricted: false })

  interface RawAccount { id?: number | string; username?: string; title?: string; email?: string; restricted?: boolean }
  const collect = (list: RawAccount[] | undefined, restrictedDefault = false) => {
    for (const u of list ?? []) {
      if (u.id == null) continue
      const id = String(u.id)
      if (byId.has(id)) continue
      byId.set(id, {
        id,
        name: u.title || u.username || u.email || `Account ${id}`,
        username: u.username ?? null,
        email: u.email ?? null,
        owner: false,
        restricted: u.restricted ?? restrictedDefault,
      })
    }
  }

  try {
    const res = await fetch(`${PLEX_TV}/friends`, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.ok) collect((await res.json()) as RawAccount[])
  } catch { /* best-effort */ }

  try {
    const res = await fetch(`${PLEX_TV}/home/users`, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.ok) {
      const data = (await res.json()) as { users?: RawAccount[] } | RawAccount[]
      collect(Array.isArray(data) ? data : data.users, true)
    }
  } catch { /* best-effort */ }

  return [...byId.values()].sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name))
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
