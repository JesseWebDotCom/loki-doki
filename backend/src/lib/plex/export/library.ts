// Per-user Plex "show" library provisioning — the piece that turns a folder on disk into
// a private library section only one specific Plex account can see.
//
// NOT verified against a live Plex server (no server available in this environment). The
// three network calls below are built from documented/community-known Plex API shapes
// (python-plexapi conventions, a real shared_servers usage example) — expect the exact
// field names/response shapes to need correction once tested against a real server. Every
// step is wrapped so a failure lands as plexLibrarySections.status='error' with a message,
// not a crash, specifically so that first live test is diagnosable.

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { plexLibrarySections, users } from '@/db/schema'
import { getPlexConnection, machineId, type PlexConnection } from '@/lib/plex/index'
import { getUserOwnPlexToken } from '@/lib/plex/account'
import { getPlexAccountInfo } from '@/lib/plex/auth'
import { getContentTypeStorageLocationId, getStorageLocationPath, toPlexPath, joinUnderRoot } from '@/lib/storage/contentRoots'
import { userSlug } from '@/lib/storage/paths'
import { logger } from '@/lib/logger'

const CLIENT_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'X-Plex-Product': 'Media Companion',
  'X-Plex-Version': '1.0',
  'X-Plex-Client-Identifier': 'media-companion-server',
}
const TIMEOUT_MS = 15_000

export interface ProvisionResult { ok: boolean; error?: string }

/** The app-side root a content type's per-user Plex tree lives under, e.g.
 *  `<storageLocationRoot>/youtube/<userSlug>`. Same convention regardless of content type. */
export async function userContentRoot(contentType: string, userId: string, firstName: string): Promise<string> {
  const storageLocationId = await getContentTypeStorageLocationId(contentType)
  const root = await getStorageLocationPath(storageLocationId)
  return joinUnderRoot(root, contentType, userSlug(userId, firstName))
}

/** Create a Plex "show" library section pointed at `plexLocation`, returning its section key. */
async function createShowLibrarySection(conn: PlexConnection, name: string, plexLocation: string): Promise<string | null> {
  const params = new URLSearchParams({
    name,
    type: 'show',
    // Modern Plex agent ids (post metadata-agent overhaul) — the "none" agent + Local Media
    // Assets is exactly the NFO-driven, no-online-scraper path this feature relies on.
    // UNVERIFIED: older Plex Media Server versions may still expect the legacy
    // 'com.plexapp.agents.none' identifier instead.
    agent: 'tv.plex.agents.none',
    scanner: 'Plex Series Scanner',
    language: 'en-US',
    location: plexLocation,
    'X-Plex-Token': conn.token,
  })
  try {
    const res = await fetch(`${conn.baseUrl}/library/sections?${params.toString()}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn(`[plex-export] create library section failed: ${res.status} ${await res.text().catch(() => '')}`)
      return null
    }
    // Some PMS versions return the new section inline; others return an empty ack and
    // require a follow-up list call — handle both.
    const data = await res.json().catch(() => null) as { MediaContainer?: { Directory?: Array<{ key?: string; title?: string }> } } | null
    const inline = data?.MediaContainer?.Directory?.find(d => d.title === name)?.key
    if (inline) return inline

    const listRes = await fetch(`${conn.baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const listData = await listRes.json().catch(() => null) as { MediaContainer?: { Directory?: Array<{ key?: string; title?: string }> } } | null
    return listData?.MediaContainer?.Directory?.find(d => d.title === name)?.key ?? null
  } catch (err) {
    logger.warn(`[plex-export] create library section threw: ${err}`)
    return null
  }
}

/** Grant a library section to exactly one Plex account via the (documented, community-
 *  confirmed) legacy shared_servers API. Returns the sharedServerId if Plex gives us one
 *  (needed to update/revoke later) — null on success without one, since a 2xx here is what
 *  actually matters for "did the share happen." */
async function shareLibrarySection(
  adminConn: PlexConnection, machineIdentifier: string, sectionKey: string, invitedPlexAccountId: string,
): Promise<{ ok: boolean; sharedServerId: string | null; error?: string }> {
  const body = new URLSearchParams()
  body.set('server_id', machineIdentifier)
  body.append('shared_server[library_section_ids][]', sectionKey)
  body.set('shared_server[invited_id]', invitedPlexAccountId)
  try {
    const res = await fetch(`https://plex.tv/api/servers/${encodeURIComponent(machineIdentifier)}/shared_servers`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Plex-Token': adminConn.token },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, sharedServerId: null, error: `share failed: ${res.status} ${text.slice(0, 300)}` }
    }
    const data = await res.json().catch(() => null) as { id?: string | number } | null
    return { ok: true, sharedServerId: data?.id != null ? String(data.id) : null }
  } catch (err) {
    return { ok: false, sharedServerId: null, error: `share threw: ${err}` }
  }
}

/**
 * Full provisioning flow for one (user, content type): create the show library at that
 * user's subfolder, share it to only their Plex account. Idempotent-ish — if a row already
 * exists and is 'ready', this is a no-op; call again after fixing an 'error' row to retry.
 */
export async function provisionUserLibrary(userId: string, contentType: string): Promise<ProvisionResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return { ok: false, error: 'User not found.' }

  const [existing] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, contentType)))
  if (existing?.status === 'ready') return { ok: true }

  const now = new Date()
  async function fail(error: string): Promise<ProvisionResult> {
    if (existing) {
      await db.update(plexLibrarySections).set({ status: 'error', error, updatedAt: now }).where(eq(plexLibrarySections.id, existing.id))
    } else {
      await db.insert(plexLibrarySections).values({
        id: crypto.randomUUID(), userId, contentType, status: 'error', error, createdAt: now, updatedAt: now,
      })
    }
    return { ok: false, error }
  }

  const adminConn = await getPlexConnection()
  if (!adminConn) return fail('Plex server is not configured (Admin → Plex).')

  const userToken = await getUserOwnPlexToken(userId)
  if (!userToken) return fail('This user has not linked their own Plex account yet.')

  const account = await getPlexAccountInfo(userToken)
  if (!account) return fail('Could not resolve this user’s Plex account identity.')

  const rootAbsPath = await userContentRoot(contentType, userId, user.firstName)
  const storageLocationId = await getContentTypeStorageLocationId(contentType)
  const plexLocation = await toPlexPath(storageLocationId, rootAbsPath)
  if (!plexLocation) {
    return fail(`No Plex path mapping configured for ${contentType}'s storage location (Admin → Storage Locations).`)
  }

  if (existing) {
    await db.update(plexLibrarySections).set({ status: 'provisioning', error: null, updatedAt: now }).where(eq(plexLibrarySections.id, existing.id))
  } else {
    await db.insert(plexLibrarySections).values({
      id: crypto.randomUUID(), userId, contentType, status: 'provisioning', rootAbsPath, createdAt: now, updatedAt: now,
    })
  }

  const mid = await machineId(adminConn)
  if (!mid) return fail('Could not resolve the Plex server’s machine identifier.')

  const sectionName = contentType === 'youtube' ? 'YouTube' : contentType
  const sectionKey = await createShowLibrarySection(adminConn, sectionName, plexLocation)
  if (!sectionKey) return fail('Failed to create the Plex library section — see server logs.')

  const share = await shareLibrarySection(adminConn, mid, sectionKey, account.id)
  if (!share.ok) return fail(share.error ?? 'Failed to share the library to this user’s account.')

  await db.update(plexLibrarySections).set({
    status: 'ready', error: null, plexSectionKey: sectionKey, plexMachineIdentifier: mid,
    sharedServerId: share.sharedServerId, rootAbsPath, updatedAt: new Date(),
  }).where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, contentType)))

  logger.info(`[plex-export] provisioned "${sectionName}" library for user ${userId}`)
  return { ok: true }
}

export interface PlexProvisionJobPayload { userId: string; contentType: string }

/** Job-queue runner wrapper — throws on failure (the row itself already records the error
 *  message via provisionUserLibrary's own fail() path; throwing is just what makes the
 *  job queue's retry/backoff and terminal-failure notification engage). */
export async function runPlexProvisionJob(payload: PlexProvisionJobPayload): Promise<void> {
  const result = await provisionUserLibrary(payload.userId, payload.contentType)
  if (!result.ok) throw new Error(result.error ?? 'Plex provisioning failed')
}
