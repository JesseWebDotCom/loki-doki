// Per-user Plex "show" library provisioning — the piece that turns a folder on disk into
// a private library section only one specific Plex account can see.
//
// Verified live (2026-07) against a real PMS instance: agent/scanner pairing, the owner
// can't-be-a-share-target case, the shared_servers request shape, and the SMB-hardlink
// ENOTSUP placement fallback were all found and fixed via direct testing, not guesswork.
// Every step is wrapped so a failure lands as plexLibrarySections.status='error' with a
// message, not a crash.

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { plexLibrarySections, users, ytDownloads } from '@/db/schema'
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
/** Set one per-library preference via the DEDICATED prefs sub-route — confirmed live that
 *  this is NOT the same as PUT /library/sections/{id} (that one 400s for prefs like this;
 *  it's only for name/agent/scanner/language). Best-effort: a failed pref set shouldn't
 *  block provisioning, just leaves that one display preference at its default. */
async function setLibraryPref(conn: PlexConnection, sectionKey: string, key: string, value: string): Promise<void> {
  try {
    await fetch(`${conn.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/prefs?${key}=${encodeURIComponent(value)}&X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      method: 'PUT', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn(`[plex-export] setLibraryPref(${key}) failed: ${err}`)
  }
}

async function createShowLibrarySection(conn: PlexConnection, name: string, plexLocation: string): Promise<string | null> {
  const params = new URLSearchParams({
    name,
    type: 'show',
    // Verified live (2026-07) against a real PMS instance. Originally used agent=
    // 'tv.plex.agents.none' ("Personal Media Shows", the "no online matching" agent) —
    // reverted after confirming live that it never actually read our NFO files at all:
    // that agent needs "Local Media Assets" manually enabled+reordered to the top of a
    // legacy per-server "Agent sources" list (Settings → Agents, no API for it), and
    // doesn't expose useLocalAssets/respectTags prefs. tv.plex.agents.series ("Plex TV
    // Series", the modern unified agent — same one this server's own working "Guitar
    // Videos" library uses) exposes those two prefs directly via PUT and defaults them
    // to true. Even so, this agent's "Prefer local metadata" turned out to mean embedded
    // MP4 tags, not our sidecar .nfo files (confirmed live: title/plot never showed even
    // after a real Refresh Metadata) — see placement.ts's placeVideoWithMetadata, which
    // embeds title/plot directly into the file via ffmpeg to work around that.
    agent: 'tv.plex.agents.series',
    scanner: 'Plex TV Series',
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
    let sectionKey = data?.MediaContainer?.Directory?.find(d => d.title === name)?.key ?? null

    if (!sectionKey) {
      const listRes = await fetch(`${conn.baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(conn.token)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const listData = await listRes.json().catch(() => null) as { MediaContainer?: { Directory?: Array<{ key?: string; title?: string }> } } | null
      sectionKey = listData?.MediaContainer?.Directory?.find(d => d.title === name)?.key ?? null
    }

    if (sectionKey) {
      // flattenSeasons=1 ("Hide"): removes season-level navigation entirely, so episode
      // posters surface directly on Home/Recommended/the show page instead of being buried
      // a click deep behind a season tile — explicitly requested over the season-per-year
      // structure once it became clear that structure only adds clicks, no real value, for
      // content that's naturally one continuous stream rather than discrete TV seasons.
      await setLibraryPref(conn, sectionKey, 'flattenSeasons', '1')
      // Harmless with seasons flattened (nothing left to show a season title on) — kept for
      // if flattenSeasons is ever turned back off, so <namedseason> tags still take effect.
      await setLibraryPref(conn, sectionKey, 'useSeasonTitles', 'true')
      // Default sort (0, "Oldest first") means a channel's very first-ever upload always
      // leads a flattened episode list, with new saves buried at the bottom — the opposite
      // of how a YouTube channel page (or anyone's expectation of "recent videos") works.
      // 1 = Newest first.
      await setLibraryPref(conn, sectionKey, 'episodeSort', '1')
      // respectTags is the API id of the "Prefer local metadata" toggle (its label/summary
      // in /prefs say exactly that — "prefer embedded tags and local files"). Without it the
      // "Plex TV Series" agent ignores the title/plot MP4 atoms placement embeds (see
      // placement.ts's placeVideoWithMetadata comment) and every episode shows as a bare
      // "Episode N" with no description — confirmed live on a freshly provisioned section,
      // where it defaults off. (preferLocalMetadata is NOT a valid pref id here — 400.)
      await setLibraryPref(conn, sectionKey, 'respectTags', '1')
    }
    return sectionKey
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

  // The owner can't be a RESTRICTED share target (discovered live: the invite API 404s,
  // since there's no "grant" to create), but that's not a dead end — the owner automatically
  // sees every library that exists on the server the instant it's created, with zero explicit
  // share needed. So for the owner, section creation itself IS the success condition; the
  // share call is skipped rather than treated as a failure. (Isolation is still real for
  // everyone else: a non-owner's Plex client only shows libraries actually shared to them —
  // the owner seeing all of them too, including other users' own YouTube libraries, is an
  // inherent property of being the account that owns the server, not a bug in this feature.)
  const adminAccount = await getPlexAccountInfo(adminConn.token)
  const isOwner = !!adminAccount && adminAccount.id === account.id

  const rootAbsPath = await userContentRoot(contentType, userId, user.firstName)
  const storageLocationId = await getContentTypeStorageLocationId(contentType)
  const plexLocation = await toPlexPath(storageLocationId, rootAbsPath)
  if (!plexLocation) {
    // This string is shown both inline in the admin UI (where "above" would be accurate right
    // now) AND in server logs on job exhaustion (where a relative position means nothing) —
    // kept self-contained/absolute so it reads correctly in either place.
    return fail(`No Plex path mapping configured for ${contentType}'s storage location — add a Storage Location with a Plex path mapping in Admin → Integrations → Plex.`)
  }

  const rowId = existing?.id ?? crypto.randomUUID()
  if (existing) {
    await db.update(plexLibrarySections).set({ status: 'provisioning', error: null, updatedAt: now }).where(eq(plexLibrarySections.id, existing.id))
  } else {
    await db.insert(plexLibrarySections).values({
      id: rowId, userId, contentType, status: 'provisioning', rootAbsPath, createdAt: now, updatedAt: now,
    })
  }

  const mid = await machineId(adminConn)
  if (!mid) return fail('Could not resolve the Plex server’s machine identifier.')

  // Reuse a section already created by a PRIOR attempt that failed at the share step —
  // otherwise every retry creates a brand-new, never-shared duplicate on the real server
  // (found live: 3 orphaned "YouTube" sections after 3 retries, since nothing persisted the
  // section key until full success).
  let sectionKey = existing?.plexSectionKey ?? null
  if (!sectionKey) {
    const sectionName = contentType === 'youtube' ? 'YouTube' : contentType
    sectionKey = await createShowLibrarySection(adminConn, sectionName, plexLocation)
    if (!sectionKey) return fail('Failed to create the Plex library section — see server logs.')
    // Persist immediately, before attempting the (separately failure-prone) share step, so a
    // retry after a share failure reuses this section instead of creating another one.
    await db.update(plexLibrarySections).set({ plexSectionKey: sectionKey, plexMachineIdentifier: mid, updatedAt: new Date() })
      .where(eq(plexLibrarySections.id, rowId))
  }

  let sharedServerId: string | null = null
  if (isOwner) {
    logger.info(`[plex-export] user ${userId} is the server owner — skipping the share call, owner access is automatic`)
  } else {
    const share = await shareLibrarySection(adminConn, mid, sectionKey, account.id)
    if (!share.ok) return fail(share.error ?? 'Failed to share the library to this user’s account.')
    sharedServerId = share.sharedServerId
  }

  await db.update(plexLibrarySections).set({
    status: 'ready', error: null, plexSectionKey: sectionKey, plexMachineIdentifier: mid,
    sharedServerId, rootAbsPath, updatedAt: new Date(),
  }).where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, contentType)))

  logger.info(`[plex-export] provisioned "${contentType}" library (section ${sectionKey}) for user ${userId}`)
  return { ok: true }
}

export interface PlexProvisionJobPayload { userId: string; contentType: string }

/** Job-queue runner wrapper — throws on failure (the row itself already records the error
 *  message via provisionUserLibrary's own fail() path; throwing is just what makes the
 *  job queue's retry/backoff and terminal-failure notification engage). */
export async function runPlexProvisionJob(payload: PlexProvisionJobPayload): Promise<void> {
  const result = await provisionUserLibrary(payload.userId, payload.contentType)
  if (!result.ok) throw new Error(result.error ?? 'Plex provisioning failed')

  // Backfill: a section that just went 'ready' otherwise stays empty until someone thinks
  // to click "Sync to Plex" manually (found live — "my library was blank" after a
  // successful provision). Provisioning a user with an existing library should retroactively
  // populate it the same way enabling it for a new save does going forward.
  if (payload.contentType === 'youtube') {
    const { enqueuePlexSync } = await import('@/lib/downloadJobs')
    // prefetch=true rows are speculative cache-warming, never a real user save — see the
    // matching note on the /plex/sync-all route for the live-confirmed leak this prevents.
    const rows = await db.select({ videoId: ytDownloads.videoId }).from(ytDownloads)
      .where(and(eq(ytDownloads.userId, payload.userId), eq(ytDownloads.kind, 'video'), eq(ytDownloads.status, 'ready'), eq(ytDownloads.prefetch, false)))
    for (const r of rows) await enqueuePlexSync(payload.userId, r.videoId, 'add')
    logger.info(`[plex-export] backfilled ${rows.length} existing video(s) into user ${payload.userId}'s new youtube library`)
  }
}
